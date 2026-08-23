import { DISPATCH_DIR, dispatchDbPath } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { resolveStoreBackend, startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth, wsUrl } from './testAuth.js';

// A daemon opened on `backend: 'sqlite'` must serve exactly the same HTTP
// surface as one opened on files — that is the whole point of routing
// everything through the store port. These tests drive the real endpoints
// rather than the store directly, so they fail if any handler reached past
// the port to the filesystem.

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

describe('resolveStoreBackend', () => {
  const original = process.env.DISPATCH_STORE_BACKEND;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatch-backend-'));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_STORE_BACKEND;
    else process.env.DISPATCH_STORE_BACKEND = original;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMarker(backend: string): void {
    mkdirSync(join(dir, DISPATCH_DIR), { recursive: true });
    writeFileSync(
      join(dir, DISPATCH_DIR, 'storage.json'),
      JSON.stringify({ backend })
    );
  }

  it('defaults to files so a not-yet-imported project keeps its markdown', () => {
    delete process.env.DISPATCH_STORE_BACKEND;
    expect(resolveStoreBackend(dir)).toBe('files');
  });

  it('treats an empty value as unset', () => {
    process.env.DISPATCH_STORE_BACKEND = '';
    expect(resolveStoreBackend(dir)).toBe('files');
  });

  it('honours an explicit sqlite for a project with no board yet', () => {
    process.env.DISPATCH_STORE_BACKEND = 'sqlite';
    expect(resolveStoreBackend(dir)).toBe('sqlite');
  });

  it('falls back to files on a typo rather than failing boot', () => {
    process.env.DISPATCH_STORE_BACKEND = 'nonsense';
    expect(resolveStoreBackend(dir)).toBe('files');
  });

  // The split-brain fix: an auto-started daemon inherits whatever shell
  // spawned it, so the environment cannot be what decides this. A daemon
  // started with no variable set must still find the database.
  it("prefers the project's recorded choice over an unset environment", () => {
    delete process.env.DISPATCH_STORE_BACKEND;
    writeMarker('sqlite');
    expect(resolveStoreBackend(dir)).toBe('sqlite');
  });

  it("prefers the project's recorded choice over a conflicting environment", () => {
    process.env.DISPATCH_STORE_BACKEND = 'files';
    writeMarker('sqlite');
    expect(resolveStoreBackend(dir)).toBe('sqlite');
  });

  it('reads a corrupt marker as no choice rather than failing boot', () => {
    delete process.env.DISPATCH_STORE_BACKEND;
    mkdirSync(join(dir, DISPATCH_DIR), { recursive: true });
    writeFileSync(join(dir, DISPATCH_DIR, 'storage.json'), '{ not json');
    expect(resolveStoreBackend(dir)).toBe('files');
  });

  // This used to be refused: an empty database opened beside a populated
  // board left the project with two half-states. It is allowed now because
  // startServer runs the one-time import before serving anything, so the
  // variable is one of the two supported ways to opt a project in.
  it('accepts sqlite for a project that still has a markdown board', () => {
    process.env.DISPATCH_STORE_BACKEND = 'sqlite';
    mkdirSync(join(dir, DISPATCH_DIR, 'tasks'), { recursive: true });
    expect(resolveStoreBackend(dir)).toBe('sqlite');
  });

  it('still honours a recorded sqlite choice for a migrated project', () => {
    // After the import, a project can legitimately have both for a while.
    delete process.env.DISPATCH_STORE_BACKEND;
    mkdirSync(join(dir, DISPATCH_DIR, 'tasks'), { recursive: true });
    writeMarker('sqlite');
    expect(resolveStoreBackend(dir)).toBe('sqlite');
  });
});

describe('a daemon on the sqlite backend', () => {
  let root: string;
  let fakeHome: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    // Keeps run/actor state out of the real ~/.dispatch — test/setup.ts fails
    // the suite if anything reaches it.
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-store-backend-');
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      storeBackend: 'sqlite',
      // Large enough never to fire during a test; the syncer is disabled on
      // this backend anyway, and this keeps that an assertion below rather
      // than a dependency of the setup.
      boardSyncPeriodicMs: 10 * 60_000,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a task through the HTTP surface', async () => {
    const created = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'db-backed task', kind: 'task' }),
      })
    );
    expect(created.meta.title).toBe('db-backed task');

    const listed = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(listed.map((d: { meta: { id: string } }) => d.meta.id)).toEqual([
      created.meta.id,
    ]);

    const fetched = await json(
      await fetch(`${baseUrl}/api/tasks/${created.meta.id}`)
    );
    expect(fetched.meta.title).toBe('db-backed task');
  });

  it('applies a PATCH and reflects it in the cache-backed list', async () => {
    const created = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'patch me' }),
      })
    );
    const patched = await json(
      await fetch(`${baseUrl}/api/tasks/${created.meta.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in-progress' }),
      })
    );
    expect(patched.meta.status).toBe('in-progress');

    const listed = await json(
      await fetch(`${baseUrl}/api/tasks?status=in-progress`)
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].meta.id).toBe(created.meta.id);
  });

  it('404s an unknown task with the same message the file backend uses', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-nope00`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('task not found: t-nope00');
  });

  it('writes the database instead of a tasks directory', async () => {
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no files please' }),
    });
    expect(existsSync(dispatchDbPath(root))).toBe(true);
    // The task must NOT also have been written as markdown: two copies is
    // exactly the split-brain single-writer exists to remove.
    expect(existsSync(join(root, DISPATCH_DIR, 'tasks'))).toBe(false);
  });

  it('keeps ledger entries in the database, not ledger.jsonl', async () => {
    const created = await json(
      await fetch(`${baseUrl}/api/ledger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'decision',
          title: 'use the daemon store',
          detail: 'single writer',
        }),
      })
    );
    expect(created.id).toMatch(/^l-/);

    const listed = await json(await fetch(`${baseUrl}/api/ledger`));
    expect(listed.map((e: { title: string }) => e.title)).toEqual([
      'use the daemon store',
    ]);
    expect(existsSync(join(root, DISPATCH_DIR, 'ledger.jsonl'))).toBe(false);
  });

  // Regression: landEpicLocally writes the epic through the store but does
  // not rebuild the cache itself. On the file backend the tasks watcher
  // covered that; a database-backed daemon has no watcher, so without the
  // rebuild in the landEpic handler this endpoint would report success while
  // every subsequent read still called the epic unfinished.
  it('reflects a landed epic immediately, with no watcher to cover it', async () => {
    const epic = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ship it', kind: 'epic' }),
      })
    );
    // An epic can only land once its integration branch exists.
    runGitSync(root, ['branch', `epic/${epic.meta.id}`]);

    const landed = await fetch(`${baseUrl}/api/epics/${epic.meta.id}/land`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(landed.status).toBe(200);
    expect((await json(landed)).mode).toBe('merge');

    const after = await json(
      await fetch(`${baseUrl}/api/tasks/${epic.meta.id}`)
    );
    expect(after.meta.status).toBe('done');
  });

  // The UI's live updates ride this channel, and on this backend nothing
  // else can produce them: the tasks watcher that also broadcast on the file
  // backend is deliberately not started here, so a mutation handler failing
  // to broadcast would leave every connected client silently stale rather
  // than a few milliseconds late.
  it('broadcasts task.changed over the WebSocket after a mutation', async () => {
    const ws = new WebSocket(wsUrl(handle));
    const nextMessage = () =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('WS message timeout')),
          2000
        );
        ws.addEventListener(
          'message',
          (ev) => {
            clearTimeout(timer);
            resolve(JSON.parse(ev.data as string));
          },
          { once: true }
        );
      });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WS open failed')));
    });
    expect(await nextMessage()).toEqual({
      type: 'hello',
      version: expect.any(String),
    });

    const changed = nextMessage();
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'watch me' }),
    });
    expect(await changed).toEqual({ type: 'task.changed' });
    ws.close();
  });

  // Regression, and the severe one: the Orchestrator's context defaults
  // `findingStore` to a fresh JSONL store when none is injected, and it was
  // built before the backend-selected store existed. On sqlite that handed
  // the merge gate an empty `.dispatch/findings.jsonl` — blockedFindingReason
  // saw nothing, and a run whose task carried an adjudicated `blocked`
  // finding merged straight through the ruling meant to stop it.
  it('shares one finding store with the merge gate', async () => {
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'has a blocking finding' }),
      })
    );
    const finding = await json(
      await fetch(`${baseUrl}/api/findings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: task.meta.id,
          severity: 'critical',
          title: 'do not merge this',
          detail: 'the ruling stands',
        }),
      })
    );
    const adjudicated = await fetch(
      `${baseUrl}/api/tasks/${task.meta.id}/findings/${finding.id}/adjudicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'blocked', ruling: 'stays blocked' }),
      }
    );
    expect(adjudicated.status).toBe(200);

    // The gate reads through the orchestrator's own store, so this is only
    // non-null if that is the same database the API just wrote to.
    const reason = handle.orchestrator.blockedFindingReason(task.meta.id);
    expect(reason).not.toBeNull();
    expect(reason).toContain(task.meta.id);
  });

  it('serves ready tasks through the same graph rule', async () => {
    const blocker = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'blocker' }),
      })
    );
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'blocked',
        blockedBy: [blocker.meta.id],
      }),
    });

    const ready = await json(await fetch(`${baseUrl}/api/tasks/ready`));
    expect(ready.map((d: { meta: { title: string } }) => d.meta.title)).toEqual(
      ['blocker']
    );
  });
});
