import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { ParkingExecutor } from './messaging/harness.js';
import { runGitSync, StallingExecutor } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// GET /api/live-work: what the desktop app checks before it stops a daemon it
// did not start and spawns its own in its place.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-live-work-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let parking: ParkingExecutor;
let stalling: StallingExecutor;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  parking = new ParkingExecutor();
  stalling = new StallingExecutor();
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', stalling);
      orchestrator.registerExecutor('parking', parking);
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function get(token: string | null): Promise<Response> {
  return rawFetch(`${baseUrl}/api/live-work`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('GET /api/live-work', () => {
  it('answers the agent token with nothing live on an idle daemon', async () => {
    const res = await get(handle.tokens.agentToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ busy: [], parked: 0, waiting: 0 });
  });

  it('names an open terminal', async () => {
    const opened = await rawFetch(`${baseUrl}/api/terminals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.tokens.appToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command: ['sh', '-c', 'sleep 5'] }),
    });
    expect(opened.status).toBe(201);
    const res = await get(handle.tokens.agentToken);
    expect(((await res.json()) as { busy: string[] }).busy).toEqual([
      '1 terminal',
    ]);
  });

  it('counts a pending agent registration the agent token cannot list', async () => {
    const registered = await rawFetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.tokens.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'parked', client: 'live-work-test' }),
    });
    expect(registered.ok).toBe(true);
    const res = await get(handle.tokens.agentToken);
    expect(((await res.json()) as { waiting: number }).waiting).toBe(1);
  });

  it('counts a working run as busy and one parked on a human as parked', async () => {
    const app = { authorization: `Bearer ${handle.tokens.appToken}` };
    const post = (path: string, body: unknown) =>
      rawFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...app, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(
        (r) => r.json() as Promise<{ id?: string; meta?: { id: string } }>
      );
    const dispatch = async (executor: string) => {
      const task = await post('/api/tasks', { title: executor });
      return post(`/api/tasks/${task.meta?.id ?? ''}/runs`, { executor });
    };
    const read = async () =>
      (await (await get(handle.tokens.agentToken)).json()) as {
        busy: string[];
        parked: number;
      };
    await dispatch('claude');
    await dispatch('parking');
    await waitUntil(async () => (await read()).busy[0] === '2 live runs');
    parking.park('req-1', 'Bash', { command: 'pnpm install' });
    await waitUntil(async () => (await read()).parked === 1);
    expect((await read()).busy).toEqual(['1 live run']);
    // The working run asks a blocking question: now it only waits too.
    await rawFetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stalling.lastRunToken ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'question',
        blocking: true,
        body: 'Which database?',
      }),
    });
    await waitUntil(async () => (await read()).parked === 2);
    expect((await read()).busy).toEqual([]);
  });

  it('refuses a request with no credential', async () => {
    expect((await get(null)).status).toBe(401);
  });
});
