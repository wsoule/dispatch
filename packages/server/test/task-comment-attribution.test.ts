import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface TaskDocMeta {
  meta: { id: string };
}

interface ThreadComment {
  author: string;
  body: string;
}

// The route now writes into the task's comment thread; read that back.
async function thread(taskId: string): Promise<ThreadComment[]> {
  return json<ThreadComment[]>(
    await fetch(`${baseUrl}/api/tasks/${taskId}/comments`)
  );
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

// Never finishes, so a dispatched run stays `running` — mirrors how a real
// agent run is still live when its own MCP task_comment call proxies in.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
      notify: () => {},
    } satisfies ExecutorRun;
  },
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-task-comment-attribution-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
    },
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

async function liveRun(taskId: string): Promise<string> {
  const meta = await json<{ id: string }>(
    await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  await waitFor(async () => {
    const r = await json<{ meta: { state: string } }>(
      await fetch(`${baseUrl}/api/runs/${meta.id}`)
    );
    return r.meta.state === 'running';
  });
  return meta.id;
}

async function createTask(title: string): Promise<string> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  return task.meta.id;
}

function postComment(
  taskId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The pre-thread route older MCP servers' task_comment still proxies to.
describe('a legacy task note records who left it, in the thread', () => {
  it('credits the agent running the run named by runId', async () => {
    const taskId = await createTask('mid-run note');
    const runId = await liveRun(taskId);
    const doc = await json<TaskDocMeta>(
      await postComment(taskId, { text: 'made progress', runId })
    );
    // Still answers with the task, which is what old servers read.
    expect(doc.meta.id).toBe(taskId);
    expect(await thread(taskId)).toMatchObject([
      { author: 'agent:test/claude', body: 'made progress' },
    ]);
  });

  it("credits 'none', not the local human, when runId doesn't resolve to a known run", async () => {
    const taskId = await createTask('stale run');
    await postComment(taskId, { text: 'made progress', runId: 'r-nosuch1' });
    expect(await thread(taskId)).toMatchObject([
      { author: 'none', body: 'made progress' },
    ]);
  });

  it("credits 'none' when no runId is given at all — this endpoint has no direct-human caller", async () => {
    const taskId = await createTask('no run context');
    const doc = await json<{ body: string }>(
      await postComment(taskId, { text: 'made progress' })
    );
    // Nothing lands in Activity any more.
    expect(doc.body).not.toContain('made progress');
    expect(await thread(taskId)).toMatchObject([
      { author: 'none', body: 'made progress' },
    ]);
  });

  it('404s an unknown task', async () => {
    const res = await postComment('t-abcdef', { text: 'x' });
    expect(res.status).toBe(404);
  });

  it('400s an empty text', async () => {
    const taskId = await createTask('empty text');
    const res = await postComment(taskId, { text: '   ' });
    expect(res.status).toBe(400);
  });
});
