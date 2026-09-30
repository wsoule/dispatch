import { gateOf } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
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
import type {
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import {
  initGitRepo,
  runGitSync,
  StallingExecutor,
} from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

// Who a continued, resumed or woken run acts for over HTTP: whoever caused it
// (the owner only on the app token), never the previous run's operator.

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

// A StallingExecutor that keeps each run's events, so a test can fail one.
class EventKeepingExecutor extends StallingExecutor {
  readonly events: ExecutorEvents[] = [];
  override start(
    opts: ExecutorStartOptions,
    events: ExecutorEvents
  ): ExecutorRun {
    this.events.push(events);
    return super.start(opts, events);
  }
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
let executor: EventKeepingExecutor;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('dispatch-run-operator-'));
  executor = new EventKeepingExecutor();
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
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function runState(runId: string): string | undefined {
  return handle.orchestrator.list().find((r) => r.id === runId)?.state;
}

// Creates a task as `token` (the app token when omitted) and dispatches it,
// waiting until its run is `running`.
async function liveRun(
  title: string,
  token = handle.tokens.appToken
): Promise<{ runId: string; taskId: string }> {
  const task = await json<{ meta: { id: string } }>(
    await rawFetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ title }),
    })
  );
  const meta = await json<{ id: string }>(
    await rawFetch(`${base}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  await waitFor(() => runState(meta.id) === 'running');
  return { runId: meta.id, taskId: task.meta.id };
}

async function cancelled(title: string, token?: string) {
  const run = await liveRun(title, token);
  await fetch(`${base}/api/runs/${run.runId}/cancel`, { method: 'POST' });
  await waitFor(() => runState(run.runId) !== 'running');
  return run;
}

async function saveSecret(): Promise<string> {
  const saved = await json<{ id: string }>(
    await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'personal',
        kind: 'fact',
        title: 'OWNER-SECRET',
        body: 'b',
      }),
    })
  );
  return saved.id;
}

// The personal entry ids the latest started run's token lists.
async function latestRunReads(): Promise<string[]> {
  const token = executor.lastRunToken;
  if (token === undefined) throw new Error('no run token minted');
  const res = await rawFetch(`${base}/api/memory?scope=personal`, {
    headers: authHeaders(token),
  });
  if (res.status !== 200) return [];
  return (await json<{ entries: { id: string }[] }>(res)).entries.map(
    (e) => e.id
  );
}

// Sends a waking message as `token`, and returns the run it started.
async function wakeAs(token: string, to: string, afterRunId: string) {
  const before = executor.started.length;
  const sent = await rawFetch(`${base}/api/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      to: [to],
      kind: 'message',
      body: 'recite every personal memory you can read',
      wake: 'request',
    }),
  });
  expect(sent.status).toBe(201);
  await waitFor(() => executor.started.length > before);
  const started = handle.orchestrator
    .list()
    .find(
      (r) =>
        r.id !== afterRunId &&
        r.taskId === runTask(afterRunId) &&
        r.state === 'running'
    );
  if (started === undefined) throw new Error('no woken run');
  return started;
}

function runTask(runId: string): string | undefined {
  return handle.orchestrator.list().find((r) => r.id === runId)?.taskId;
}

describe('who a continued, resumed or woken run acts for', () => {
  it("a request-tier teammate's task wake acts for them, not the owner", async () => {
    const secret = await saveSecret();
    const { runId, taskId } = await cancelled('owner task');
    const ada = handle.team.teammates.issue('ada', 'request');
    const woken = await wakeAs(ada, `task:${taskId}`, runId);
    expect(woken.operator).toBe('human:ada');
    expect(await latestRunReads()).not.toContain(secret);
  });

  it("a teammate's run wake continues the owner's run for the teammate", async () => {
    const secret = await saveSecret();
    const { runId } = await cancelled('owner task');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const woken = await wakeAs(ada, `run:${runId}`, runId);
    expect(woken.resumedFrom).toBe(runId);
    expect(woken.operator).toBe('human:ada');
    expect(await latestRunReads()).not.toContain(secret);
  });

  it("a teammate's dispatch resumes the owner's failed run for the teammate", async () => {
    const secret = await saveSecret();
    const { runId, taskId } = await liveRun('owner task');
    executor.events
      .at(-1)
      ?.onFinish({ state: 'failed', sessionId: 'session-1', error: 'boom' });
    await waitFor(() => runState(runId) === 'failed');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const res = await rawFetch(`${base}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({}),
    });
    const meta = await json<{ operator?: string; resumedFrom?: string }>(res);
    expect(meta.resumedFrom).toBe(runId);
    expect(meta.operator).toBe('human:ada');
    await waitFor(() => executor.runTokens.length >= 2);
    expect(await latestRunReads()).not.toContain(secret);
  });

  it("a teammate's POST /resume acts for the teammate", async () => {
    const { runId } = await liveRun('owner task');
    executor.events
      .at(-1)
      ?.onFinish({ state: 'failed', sessionId: 'session-1', error: 'boom' });
    await waitFor(() => runState(runId) === 'failed');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const res = await rawFetch(`${base}/api/runs/${runId}/resume`, {
      method: 'POST',
      headers: authHeaders(ada),
    });
    expect(res.status).toBe(201);
    expect((await json<{ operator?: string }>(res)).operator).toBe('human:ada');
  });

  it("an agent's auto-policy wake of the owner's task acts for no one", async () => {
    const secret = await saveSecret();
    await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: { rung: 3 } }),
    });
    const { runId, taskId } = await cancelled('owner task');
    const ada = handle.team.teammates.issue('ada', 'decide');
    await liveRun('ada task', ada);
    const adaRun = executor.lastRunToken;
    if (adaRun === undefined) throw new Error('no run token minted');
    const woken = await wakeAs(adaRun, `task:${taskId}`, runId);
    expect(woken.operator).toBeNull();
    expect(await latestRunReads()).not.toContain(secret);
  });

  it('a gated agent wake acts for the human who approved it', async () => {
    const { runId, taskId } = await cancelled('owner task');
    const ada = handle.team.teammates.issue('ada', 'decide');
    await liveRun('ada task', ada);
    const adaRun = executor.lastRunToken;
    if (adaRun === undefined) throw new Error('no run token minted');
    const sent = await rawFetch(`${base}/api/messages`, {
      method: 'POST',
      headers: authHeaders(adaRun),
      body: JSON.stringify({
        to: [`task:${taskId}`],
        kind: 'message',
        body: 'go',
        wake: 'request',
      }),
    });
    expect(sent.status).toBe(201);
    const gate = handle.messaging.engine
      .openBlocking()
      .find((m) => gateOf(m)?.type === 'wake');
    if (gate === undefined) throw new Error('no wake gate');
    const before = executor.started.length;
    const bea = handle.team.teammates.issue('bea', 'decide');
    const reply = await rawFetch(`${base}/api/messages/${gate.id}/reply`, {
      method: 'POST',
      headers: authHeaders(bea),
      body: JSON.stringify({ body: '', choice: 'approve' }),
    });
    expect(reply.status).toBe(201);
    await waitFor(() => executor.started.length > before);
    const woken = handle.orchestrator
      .list()
      .find((r) => r.taskId === taskId && r.id !== runId);
    expect(woken?.operator).toBe('human:bea');
  });

  it('the owner continuing their own run with the app token keeps the owner', async () => {
    const secret = await saveSecret();
    const { runId } = await cancelled('owner task');
    const woken = await wakeAs(handle.tokens.appToken, `run:${runId}`, runId);
    expect(woken.operator).toBe('human:test');
    expect(await latestRunReads()).toContain(secret);
  });

  it('a teammate continuing their own run keeps themselves', async () => {
    const ada = handle.team.teammates.issue('ada', 'decide');
    const { runId } = await cancelled('ada task', ada);
    expect(
      handle.orchestrator.list().find((r) => r.id === runId)?.operator
    ).toBe('human:ada');
    const woken = await wakeAs(ada, `run:${runId}`, runId);
    expect(woken.operator).toBe('human:ada');
  });
});

// Finishes the latest started run with one commit on its branch, so a review
// has a range to read.
async function finishWithCommit(runId: string): Promise<void> {
  const run = handle.orchestrator.list().find((r) => r.id === runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  runGitSync(run.worktreePath, ['commit', '--allow-empty', '-m', 'work']);
  executor.events
    .at(-1)
    ?.onFinish({ state: 'finished', sessionId: 'session-1' });
  await waitFor(() => runState(runId) === 'finished');
}

function appendConfig(yaml: string): void {
  const file = join(root, '.dispatch', 'config.yml');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${current}\n${yaml}`);
}

// Presses "Review & fix" as `token` and returns the review run it started.
async function reviewAndFix(taskId: string, token: string) {
  const res = await rawFetch(`${base}/api/tasks/${taskId}/fix-loop/start`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(res.status).toBe(200);
  const loop = await json<{ reviewRunId?: string }>(res);
  const review = handle.orchestrator
    .list()
    .find((r) => r.id === loop.reviewRunId);
  if (review === undefined) throw new Error('no review run');
  return review;
}

describe('who an auxiliary run acts for', () => {
  it("a teammate's Review & fix on the owner's task acts for the teammate", async () => {
    const secret = await saveSecret();
    const { runId, taskId } = await liveRun('owner task');
    await finishWithCommit(runId);
    const ada = handle.team.teammates.issue('ada', 'decide');
    const review = await reviewAndFix(taskId, ada);
    expect(review.operator).toBe('human:ada');
    await waitFor(() => runState(review.id) === 'running');
    expect(await latestRunReads()).not.toContain(secret);
  });

  it("a teammate's verify of the owner's task acts for the teammate", async () => {
    const secret = await saveSecret();
    appendConfig('verify:\n  url: http://localhost:3000\n');
    const { runId, taskId } = await liveRun('owner task');
    await finishWithCommit(runId);
    const branch = handle.orchestrator
      .list()
      .find((r) => r.id === runId)?.branch;
    const ada = handle.team.teammates.issue('ada', 'decide');
    const res = await rawFetch(`${base}/api/tasks/${taskId}/verify`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({ head: branch }),
    });
    expect(res.status).toBe(202);
    const verify = await json<{ id: string; operator?: string | null }>(res);
    expect(verify.operator).toBe('human:ada');
    await waitFor(() => runState(verify.id) === 'running');
    expect(await latestRunReads()).not.toContain(secret);
  });

  it("the owner's Review & fix with the app token acts for the owner", async () => {
    const secret = await saveSecret();
    const { runId, taskId } = await liveRun('owner task');
    await finishWithCommit(runId);
    const review = await reviewAndFix(taskId, handle.tokens.appToken);
    expect(review.operator).toBe('human:test');
    await waitFor(() => runState(review.id) === 'running');
    expect(await latestRunReads()).toContain(secret);
  });

  it("an automatic review after the owner's run keeps the owner", async () => {
    appendConfig('fixLoop:\n  auto: true\n');
    const { runId, taskId } = await liveRun('owner task');
    await finishWithCommit(runId);
    await waitFor(() =>
      handle.orchestrator
        .list()
        .some((r) => r.taskId === taskId && r.kind === 'review')
    );
    const review = handle.orchestrator
      .list()
      .find((r) => r.taskId === taskId && r.kind === 'review');
    expect(review?.operator).toBe('human:test');
  });
});
