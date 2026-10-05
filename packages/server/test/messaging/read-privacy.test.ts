import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

// Response.json() types as Promise<unknown> under this repo's DOM-less
// tsconfig, so every read names the shape it expects.
function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let executor: StallingExecutor;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Dispatches a task and returns its run's minted token once the run is live.
async function liveRunToken(title: string): Promise<string> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  const started = executor.runTokens.length;
  const run = await json<{ id: string }>(
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const detail = await json<{ meta: { state: string } }>(
      await fetch(`${baseUrl}/api/runs/${run.id}`)
    );
    const token = executor.runTokens.at(started);
    if (detail.meta.state === 'running' && token !== undefined) return token;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${run.id} never went live`);
}

async function ask(token: string, body: string) {
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ to: ['human:test'], kind: 'question', body }),
  });
  return (await json<{ message: { id: string; thread: string } }>(res)).message;
}

describe('non-participants learn nothing (C6)', () => {
  let a: string;
  let b: string;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-read-privacy-');
    TaskStore.init(root);
    executor = new StallingExecutor();
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', executor);
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    a = await liveRunToken('Task A');
    b = await liveRunToken('Task B');
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('gets the absent-id 404 on every read route', async () => {
    const { id, thread } = await ask(a, 'private?');
    for (const [path, absent] of [
      [`/api/messages/${id}`, '/api/messages/m-absent'],
      [`/api/messages/${id}/answer`, '/api/messages/m-absent/answer'],
      [`/api/threads/${thread}`, '/api/threads/m-absent'],
    ] as const) {
      const foreign = await fetch(`${baseUrl}${path}`, {
        headers: authHeaders(b),
      });
      const missing = await fetch(`${baseUrl}${absent}`, {
        headers: authHeaders(b),
      });
      expect({ path, statuses: [foreign.status, missing.status] }).toEqual({
        path,
        statuses: [404, 404],
      });
      const f = await json<{ error: string }>(foreign);
      const m = await json<{ error: string }>(missing);
      expect(f.error.replace(id, '<id>').replace(thread, '<id>')).toBe(
        m.error.replace('m-absent', '<id>')
      );
    }
  });

  it('still serves the participant and a deciding human', async () => {
    const { id, thread } = await ask(a, 'mine');
    for (const path of [
      `/api/messages/${id}`,
      `/api/messages/${id}/answer`,
      `/api/threads/${thread}`,
    ]) {
      const own = await fetch(`${baseUrl}${path}`, { headers: authHeaders(a) });
      // useTestAuth adds the app token, a deciding human's.
      const decider = await fetch(`${baseUrl}${path}`);
      expect({ path, statuses: [own.status, decider.status] }).toEqual({
        path,
        statuses: [200, 200],
      });
    }
  });
});
