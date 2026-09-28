import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// On a daemon two people use, a write must be credited to whoever made it.
// Before tokens named people every human write read as the operator's,
// because the operator was the only human there could be.

// Never finishes, so a dispatched run just sits there to be inspected.
const idle: Executor = {
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

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-attribution-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'wyat@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Wyat']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let ada: string;
const originalHome = process.env.DISPATCH_HOME;

function headers(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

async function post(path: string, token: string, body: object) {
  return rawFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
}

async function newTask(token: string, title: string): Promise<string> {
  const res = await post('/api/tasks', token, { title });
  return ((await res.json()) as { meta: { id: string } }).meta.id;
}

// A run `token` dispatched that has already stopped, ready to be continued.
async function stoppedRunBy(token: string): Promise<string> {
  const taskId = await newTask(token, 'Widget');
  const res = await post(`/api/tasks/${taskId}/runs`, token, {
    executor: 'stops',
  });
  const runId = ((await res.json()) as { id: string }).id;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await rawFetch(`${baseUrl}/api/runs/${runId}`, {
      headers: headers(token),
    });
    const { meta } = (await run.json()) as { meta: { state: string } };
    if (meta.state === 'failed') return runId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} never stopped`);
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
  // Committed so a run's worktree can branch from it.
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'dispatch init']);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', idle);
      // Stops at once with a session to resume, as a cut-off run does.
      orchestrator.registerExecutor(
        'stops',
        new FakeExecutor({
          session: 'session-1',
          finish: { state: 'failed', error: 'cut off', sessionId: 'session-1' },
        })
      );
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const issued = await post('/api/team/tokens', handle.tokens.appToken, {
    email: 'ada@example.com',
    displayName: 'Ada',
  });
  ada = ((await issued.json()) as { token: string }).token;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('attribution on a shared daemon', () => {
  it("a teammate's finding is raised by them, not the operator", async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', ada, {
      taskId,
      severity: 'minor',
      title: 'Typo in the label',
      detail: 'Label is misspelled.',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:ada'
    );
  });

  it("a teammate's activity note is credited to them", async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    await rawFetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: headers(ada),
      body: JSON.stringify({ appendActivity: 'looked at this' }),
    });
    const task = (await (
      await rawFetch(`${baseUrl}/api/tasks/${taskId}`, {
        headers: headers(ada),
      })
    ).json()) as { body: string };
    expect(task.body).toContain('human:ada');
    expect(task.body).not.toContain('looked at this (human:wyat)');
  });

  it('a run records who dispatched it', async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post(`/api/tasks/${taskId}/runs`, ada, {});
    expect(res.status).toBe(201);
    expect(((await res.json()) as { dispatchedBy?: string }).dispatchedBy).toBe(
      'human:ada'
    );
  });

  it("a teammate's follow-up on her own run stays hers", async () => {
    // Every way to send a stopped run back: the composer's request-changes,
    // the review's send-back and a request-changes verdict.
    const message = await post(
      `/api/runs/${await stoppedRunBy(ada)}/message`,
      ada,
      { text: 'try again', resume: true }
    );
    expect(message.status).toBe(200);
    expect(
      ((await message.json()) as { dispatchedBy?: string }).dispatchedBy
    ).toBe('human:ada');

    const sendBack = await post(
      `/api/runs/${await stoppedRunBy(ada)}/send-back`,
      ada,
      { note: 'try again' }
    );
    expect(sendBack.status).toBe(200);
    expect(
      ((await sendBack.json()) as { dispatchedBy?: string }).dispatchedBy
    ).toBe('human:ada');

    const verdict = await post(
      `/api/runs/${await stoppedRunBy(ada)}/review-submit`,
      ada,
      { verdict: 'request-changes', body: 'try again' }
    );
    expect(verdict.status).toBe(200);
    expect(
      ((await verdict.json()) as { run?: { dispatchedBy?: string } }).run
        ?.dispatchedBy
    ).toBe('human:ada');
  });

  it('the operator is still credited as themselves', async () => {
    // Nothing changes for a solo project: the built-in pair names the
    // operator, exactly as every write was credited before.
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', handle.tokens.appToken, {
      taskId,
      severity: 'minor',
      title: 'Mine',
      detail: 'Operator note.',
    });
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:wyat'
    );
  });

  it('a body cannot forge whose write it was', async () => {
    const taskId = await newTask(handle.tokens.appToken, 'Widget');
    const res = await post('/api/findings', ada, {
      taskId,
      severity: 'minor',
      title: 'Sneaky',
      detail: 'Pretends to be the operator.',
      raisedBy: 'human:wyat',
    });
    expect(((await res.json()) as { raisedBy: string }).raisedBy).toBe(
      'human:ada'
    );
  });
});
