import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IdleShutdown } from '../src/idleShutdown.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth, wsUrl } from './testAuth.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Positive assertions poll rather than sleep a fixed amount, so a loaded CI
// runner whose timers fire late does not turn a pass into a flake.
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

describe('IdleShutdown', () => {
  const live: IdleShutdown[] = [];
  afterEach(() => {
    for (const idle of live) idle.stop();
    live.length = 0;
  });

  function make(isBusy: () => boolean, onIdle: () => void): IdleShutdown {
    const idle = new IdleShutdown({
      timeoutMs: 40,
      checkIntervalMs: 10,
      isBusy,
      onIdle,
    });
    live.push(idle);
    return idle;
  }

  it('fires once after the timeout passes with nothing going on', async () => {
    let fired = 0;
    make(
      () => false,
      () => (fired += 1)
    );

    await waitFor(() => fired > 0);
    await sleep(50);

    expect(fired).toBe(1);
  });

  it('never fires while the caller reports busy', async () => {
    let fired = 0;
    make(
      () => true,
      () => (fired += 1)
    );

    await sleep(150);

    expect(fired).toBe(0);
  });

  it('stays up for the whole of a request that outlasts the timeout', async () => {
    let fired = 0;
    const idle = make(
      () => false,
      () => (fired += 1)
    );

    // A blocking msg_send's long-poll: in flight for three timeouts' worth.
    await idle.track(() => sleep(120));
    expect(fired).toBe(0);

    await waitFor(() => fired === 1);
  });

  it('restarts the countdown after each request', async () => {
    let fired = 0;
    const idle = make(
      () => false,
      () => (fired += 1)
    );

    for (let i = 0; i < 6; i++) {
      await sleep(20);
      await idle.track(() => Promise.resolve());
    }

    expect(fired).toBe(0);
  });
});

// End to end through startServer: the same rule, fed by the real request
// path and the real WebSocket client set.
describe('startServer idleTimeoutMs', () => {
  let fakeHome: string;
  let root: string;
  let handle: ServerHandle | undefined;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-idle-'));
    runGitSync(root, ['init', '-b', 'main']);
    runGitSync(root, ['config', 'user.email', 'test@example.com']);
    runGitSync(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'README.md'), '# test repo\n');
    runGitSync(root, ['add', '-A']);
    runGitSync(root, ['commit', '-m', 'initial commit']);
    TaskStore.init(root);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function start(onIdle: () => void): Promise<ServerHandle> {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: () => {},
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 20,
      onIdle,
    });
    useTestAuth(handle);
    return handle;
  }

  it('calls onIdle once nothing has used the daemon for the timeout', async () => {
    let fired = 0;
    await start(() => (fired += 1));

    await waitFor(() => fired === 1);
  });

  it('stays up while a client is connected, and goes once it leaves', async () => {
    let fired = 0;
    const server = await start(() => (fired += 1));
    const ws = new WebSocket(wsUrl(server));
    await new Promise((resolve) => ws.addEventListener('open', resolve));

    await sleep(500);
    expect(fired).toBe(0);

    ws.close();
    await waitFor(() => fired === 1);
  });

  it('counts API requests as use', async () => {
    let fired = 0;
    const server = await start(() => (fired += 1));

    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${server.port}/api/health`);
      await sleep(50);
    }

    expect(fired).toBe(0);
  });
});
