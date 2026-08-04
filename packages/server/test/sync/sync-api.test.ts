import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { runGitSync } from '../orchestrator/helpers.js';
import { useTestAuth, wsUrl } from '../testAuth.js';
import { cleanupClone, run, twoClones } from './helpers.js';

// Mirrors wiring.test.ts's own copy exactly.

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function enableAutoCommit(dir: string): void {
  const path = join(dir, '.dispatch', 'config.yml');
  const contents = readFileSync(path, 'utf8').replace(
    'autoCommit: false',
    'autoCommit: true'
  );
  writeFileSync(path, contents);
}

function installRejectingHook(bareRepo: string): void {
  const hooksDir = join(bareRepo, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-receive');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  chmodSync(hookPath, 0o755);
}

function nextMessage(
  ws: WebSocket,
  matches: (msg: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WS message timeout')),
      5000
    );
    const onMessage = (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data as string);
      if (!matches(parsed)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(parsed);
    };
    ws.addEventListener('message', onMessage);
  });
}

async function openHello(handle: ServerHandle): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(handle));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS open failed')));
  });
  await nextMessage(ws, (m) => m.type === 'hello');
  return ws;
}

interface SyncStatusBody {
  state: string;
  detail: string | null;
  pushed: number;
  pulled: number;
  pendingOutgoing: number;
  pendingIncoming: number;
  lastSyncedAt: string | null;
}

describe('GET /api/sync', () => {
  it('synthesizes `disabled` when no trunk is resolvable, and says a restart is needed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-no-git-'));
    TaskStore.init(root);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncStatusBody;

      expect(body.state).toBe('disabled');
      expect(body.detail).not.toBeNull();
      // No real SyncResult ever produces this state — this is api.ts
      // synthesizing it because boardSyncScheduler is null. Say so, and say
      // a restart is the only way out, since SyncWorktree.open() only ever
      // runs once at boot.
      expect(body.detail).toContain('restart');
      expect(body.pushed).toBe(0);
      expect(body.pulled).toBe(0);
      expect(body.pendingOutgoing).toBe(0);
      expect(body.pendingIncoming).toBe(0);
      expect(body.lastSyncedAt).toBeNull();
    } finally {
      await handle?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports `idle` with no lastSyncedAt before the scheduler has ever run', async () => {
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncStatusBody;

      expect(body.state).toBe('idle');
      expect(body.detail).toBeNull();
      expect(body.lastSyncedAt).toBeNull();
      expect(body.pendingOutgoing).toBe(0);
      expect(body.pendingIncoming).toBe(0);
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('reports pushed/pulled, a lastSyncedAt, and live pending counts after a real sync', async () => {
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        boardSyncDebounceMs: 15,
      });
      useTestAuth(handle);
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const ws = await openHello(handle);

      const boardSync = nextMessage(ws, (m) => m.type === 'board.sync');
      const create = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Synced task' }),
      });
      expect(create.status).toBe(201);
      await boardSync;
      ws.close();

      // A second, not-yet-synced local edit — proves pendingOutgoing is
      // computed live rather than frozen at the last SyncResult.
      new TaskStore(a).create({ title: 'Not synced yet' });

      const res = await fetch(`${baseUrl}/api/sync`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncStatusBody;

      expect(body.state).toBe('idle');
      expect(body.detail).toBeNull();
      expect(body.pushed).toBe(1);
      expect(body.lastSyncedAt).not.toBeNull();
      expect(new Date(body.lastSyncedAt ?? '').getTime()).not.toBeNaN();
      expect(body.pendingOutgoing).toBe(1);
      expect(body.pendingIncoming).toBe(0);
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('reports `local-only` with the push failure as detail', async () => {
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);
    installRejectingHook(origin);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        boardSyncDebounceMs: 15,
      });
      useTestAuth(handle);
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const ws = await openHello(handle);

      const boardSync = nextMessage(ws, (m) => m.type === 'board.sync');
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Will not push' }),
      });
      await boardSync;
      ws.close();

      const res = await fetch(`${baseUrl}/api/sync`);
      const body = (await res.json()) as SyncStatusBody;

      expect(body.state).toBe('local-only');
      expect(body.detail).not.toBeNull();
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('synthesizes `off` for a project with autoCommit: false, and never creates the sync worktree', async () => {
    // twoClones() defaults to autoCommit: false — the state every existing
    // project starts in, and the exact case that used to run a full
    // `git worktree add` off a plain GET.
    const { origin, a, b } = twoClones();

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncStatusBody;

      expect(body.state).toBe('off');
      expect(body.detail).not.toBeNull();
      expect(body.pendingOutgoing).toBe(0);
      expect(body.pendingIncoming).toBe(0);

      const worktree = SyncWorktree.open(a, run);
      expect(worktree).not.toBeNull();
      expect(existsSync(worktree?.path ?? '')).toBe(false);
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('reports mergeDriverWarning null when the merge driver resolves, non-null when it does not', async () => {
    // twoClones() registers the test harness's own driver (`bun cli.ts
    // merge-task ...`), which resolves — the positive case.
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      const body = (await res.json()) as SyncStatusBody & {
        mergeDriverWarning: string | null;
      };
      expect(body.mergeDriverWarning).toBeNull();
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('reports a non-null mergeDriverWarning when no merge driver was ever registered', async () => {
    // No `dispatch init` / registerMergeDriverGitConfig call at all — the
    // fresh-repo/never-set-up case, and the state most repos in this test
    // suite are actually in.
    const root = mkdtempSync(join(tmpdir(), 'dispatch-no-driver-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: root,
    });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'initial'], {
      cwd: root,
    });
    TaskStore.init(root);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      const body = (await res.json()) as SyncStatusBody & {
        mergeDriverWarning: string | null;
      };
      expect(body.mergeDriverWarning).not.toBeNull();
    } finally {
      await handle?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('401s without a token, like every other read route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-no-git-'));
    TaskStore.init(root);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      // Deliberately not calling useTestAuth — this request carries no token.
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sync`);
      expect(res.status).toBe(401);
    } finally {
      await handle?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/config — turning autoCommit off', () => {
  it('removes the sync worktree and its git worktree registration', async () => {
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        boardSyncDebounceMs: 15,
      });
      useTestAuth(handle);
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      const ws = await openHello(handle);

      // A real sync first, so the worktree actually exists — otherwise this
      // test would pass even without a working removeWorktree() call.
      const boardSync = nextMessage(ws, (m) => m.type === 'board.sync');
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Creates the worktree' }),
      });
      await boardSync;
      ws.close();

      const worktree = SyncWorktree.open(a, run);
      if (worktree === null) throw new Error('expected a resolvable trunk');
      expect(existsSync(worktree.path)).toBe(true);
      // Captured before removal (git resolves symlinks like macOS's
      // /tmp -> /private/tmp in worktree paths, so a raw string compare
      // against worktree.path itself would miss a real registration).
      const realWorktreePath = realpathSync(worktree.path);

      const patch = await fetch(`${baseUrl}/api/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoCommit: false }),
      });
      expect(patch.status).toBe(200);

      expect(existsSync(worktree.path)).toBe(false);
      // Not `list.includes('board')`: twoClones() itself names each clone's
      // temp directory `dispatch-board-<name>-…`, so the MAIN worktree's own
      // entry already contains that substring — assert on the sync
      // worktree's actual (registered, realpath'd) path instead.
      const list = runGitSync(a, ['worktree', 'list', '--porcelain']);
      expect(list.includes(realWorktreePath)).toBe(false);
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('is a harmless no-op when the worktree was never created', async () => {
    const { origin, a, b } = twoClones();
    // Never enabled, never synced — the worktree never came into being.

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
      });
      useTestAuth(handle);
      const baseUrl = `http://127.0.0.1:${handle.port}`;

      const patch = await fetch(`${baseUrl}/api/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoCommit: false }),
      });
      expect(patch.status).toBe(200);
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });
});
