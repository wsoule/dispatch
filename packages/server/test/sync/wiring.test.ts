import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runGitSync } from '../orchestrator/helpers.js';
import { useTestAuth, wsUrl } from '../testAuth.js';
import { cleanupClone, twoClones } from './helpers.js';

// Proves the real production call chain end to end: an API write broadcasts
// `task.changed` -> BoardSyncScheduler.notifyTaskChanged() (subscribed in
// startServer) -> a debounced BoardSyncer.syncOnce() -> a `board.sync`
// broadcast, with the commit actually landing on the bare origin. Nothing
// here goes through the syncerFor()-style direct harness used elsewhere in
// this suite — this is startServer() itself, unmodified.

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

describe('board sync production wiring', () => {
  it('an API task write reaches the board syncer and pushes to origin', async () => {
    const { origin, a, b } = twoClones();
    enableAutoCommit(a);

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: a,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        boardSyncDebounceMs: 20,
      });
      useTestAuth(handle);
      const baseUrl = `http://127.0.0.1:${handle.port}`;

      const ws = new WebSocket(wsUrl(handle));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('WS open failed')));
      });
      await nextMessage(ws, (m) => m.type === 'hello');

      const boardSync = nextMessage(ws, (m) => m.type === 'board.sync');
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Wired through startServer' }),
      });
      expect(res.status).toBe(201);

      const event = (await boardSync) as unknown as {
        result: { state: string; pushed: number };
      };
      expect(event.result.state).toBe('idle');
      expect(event.result.pushed).toBe(1);

      ws.close();

      // Confirms this reached the real bare origin, not just the event bus.
      const log = runGitSync(origin, ['log', '-1', '--format=%s']);
      expect(log).toContain('sync 1 task');
    } finally {
      await handle?.stop();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });

  it('does not throw at startup when no trunk is resolvable, and never syncs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-no-git-'));
    TaskStore.init(root);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        webDistDir: null,
        boardSyncDebounceMs: 10,
      });
      useTestAuth(handle);

      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes('board sync disabled')
        )
      ).toBe(true);

      const ws = new WebSocket(wsUrl(handle));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('WS open failed')));
      });
      await nextMessage(ws, (m) => m.type === 'hello');

      let sawBoardSync = false;
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string);
        if (parsed.type === 'board.sync') sawBoardSync = true;
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No syncer here' }),
      });
      expect(res.status).toBe(201);

      // Long enough to clear the 10ms debounce several times over, proving
      // absence rather than just an unlucky timing window.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sawBoardSync).toBe(false);

      ws.close();
    } finally {
      logSpy.mockRestore();
      await handle?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
