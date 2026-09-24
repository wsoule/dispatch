import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// A run that starts and immediately reports a session, then never finishes —
// enough state for questions/messages to key off, matching the operator
// handle 'test' initGitRepo's git identity resolves to (test@example.com).
let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let executor: StallingExecutor;
const originalDispatchHome = process.env.DISPATCH_HOME;

function startTestServer(): Promise<ServerHandle> {
  return startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    },
  });
}

// Dispatches a task and waits for its run to actually be `running`, so the
// run's mint token (executor.lastStartOptions.runToken) is settled.
async function liveRun(
  title: string
): Promise<{ runId: string; taskId: string }> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  const meta = await json<{ id: string }>(
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
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
  return { runId: meta.id, taskId: task.meta.id };
}

describe('messaging HTTP routes', () => {
  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-routes-');
    TaskStore.init(root);
    executor = new StallingExecutor();
    handle = await startTestServer();
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

  it("a run asks a human a question; the human answers; the run's long-poll returns it", async () => {
    await liveRun('Ask something');
    const runToken = executor.lastStartOptions?.runToken;
    expect(runToken).toBeDefined();

    const sendRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authHeaders(runToken!),
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'question',
        blocking: true,
        choices: ['yes', 'no'],
        body: 'Proceed?',
      }),
    });
    expect(sendRes.status).toBe(201);
    const sent = await json<{ message: { id: string } }>(sendRes);
    const questionId = sent.message.id;

    // Start the long-poll before the answer exists, so this exercises the
    // subscribe-and-wait path rather than the immediate-answer shortcut.
    const answerPromise = fetch(
      `${baseUrl}/api/messages/${questionId}/answer?wait=1`,
      { headers: authHeaders(runToken!) }
    );

    const replyRes = await fetch(
      `${baseUrl}/api/messages/${questionId}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'go ahead', choice: 'yes' }),
      }
    );
    expect(replyRes.status).toBe(201);

    const answerRes = await answerPromise;
    expect(answerRes.status).toBe(200);
    const body = await json<{
      answer: { replyTo: string; choice: string } | null;
    }>(answerRes);
    expect(body.answer?.replyTo).toBe(questionId);
    expect(body.answer?.choice).toBe('yes');

    // R2-2: the run also receives the answer as a pushed message, not only
    // through the long-poll response.
    await waitFor(() => executor.sent.some((s) => s.includes('go ahead')));
  });

  it('a message to a sleeping task is held, then pushed once the task is dispatched', async () => {
    const task = await json<{ meta: { id: string } }>(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Sleepy task' }),
      })
    );

    const sendRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'wake up please',
      }),
    });
    expect(sendRes.status).toBe(201);
    const sent = await json<{ deliveries: { state: string }[] }>(sendRes);
    expect(sent.deliveries).toHaveLength(1);
    expect(sent.deliveries[0]?.state).toBe('held');

    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    });

    await waitFor(() =>
      executor.sent.some((s) => s.includes('wake up please'))
    );
  });

  it('a run joins a channel as its task; the channel list shows epic children implicitly', async () => {
    const { taskId } = await liveRun('Join a channel');
    const runToken = executor.lastStartOptions?.runToken;

    const joinRes = await fetch(`${baseUrl}/api/channels/general/members`, {
      method: 'POST',
      headers: authHeaders(runToken!),
      body: JSON.stringify({}),
    });
    expect(joinRes.status).toBe(204);

    const epic = await json<{ meta: { id: string } }>(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'An epic', kind: 'epic' }),
      })
    );
    const child = await json<{ meta: { id: string } }>(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'A child task', parent: epic.meta.id }),
      })
    );

    const channels = await json<{
      channels: { name: string; auto: boolean; members: string[] }[];
    }>(await fetch(`${baseUrl}/api/channels`));

    const general = channels.channels.find((c) => c.name === 'general');
    // The run joined as its task, so membership outlives the run itself.
    expect(general?.members).toEqual([`task:${taskId}`]);

    const epicChannel = channels.channels.find(
      (c) => c.name === `epic/${epic.meta.id}`
    );
    expect(epicChannel?.members).toEqual([`task:${child.meta.id}`]);
  });

  it("a run's own mailbox merges its run address and its task's", async () => {
    const { runId, taskId } = await liveRun('Check my own mail');
    const runToken = executor.lastStartOptions?.runToken;

    // Addressed straight to the task (most mail, since it outlives any run).
    await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [`task:${taskId}`],
        kind: 'message',
        body: 'to the task',
      }),
    });
    // Addressed straight to this run (e.g. an answer to its own question).
    await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [`run:${runId}`],
        kind: 'message',
        body: 'to the run',
      }),
    });

    const mailbox = await json<{
      items: { message: { body: string } }[];
    }>(
      await fetch(`${baseUrl}/api/mailbox`, { headers: authHeaders(runToken!) })
    );
    const bodies = mailbox.items.map((i) => i.message.body);
    expect(bodies).toContain('to the task');
    expect(bodies).toContain('to the run');
  });

  it("reading another agent's mailbox is forbidden (403)", async () => {
    const a = await json<{ address: string; token: string }>(
      await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: authHeaders(handle.tokens.agentToken),
        body: JSON.stringify({ name: 'reviewer-a', client: 'codex' }),
      })
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(a.address)}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    const b = await json<{ address: string; token: string }>(
      await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: authHeaders(handle.tokens.agentToken),
        body: JSON.stringify({ name: 'reviewer-b', client: 'codex' }),
      })
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(b.address)}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );

    const res = await fetch(
      `${baseUrl}/api/mailbox?address=${encodeURIComponent(a.address)}`,
      { headers: authHeaders(b.token) }
    );
    expect(res.status).toBe(403);
  });

  it('register -> pending 403 -> approve via app token -> send works', async () => {
    const registered = await json<{
      address: string;
      token: string;
      status: string;
    }>(
      await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: authHeaders(handle.tokens.agentToken),
        body: JSON.stringify({ name: 'ci bot', client: 'codex' }),
      })
    );
    expect(registered.status).toBe('pending');

    const beforeApproval = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authHeaders(registered.token),
      body: JSON.stringify({ to: ['human:test'], kind: 'message', body: 'hi' }),
    });
    expect(beforeApproval.status).toBe(403);
    const beforeBody = await json<{ error: string }>(beforeApproval);
    expect(beforeBody.error).toContain('awaiting approval');

    const approveRes = await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(registered.address)}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    expect(approveRes.status).toBe(200);
    const approved = await json<{ status: string; tokenHash?: string }>(
      approveRes
    );
    expect(approved.status).toBe('approved');
    expect(approved.tokenHash).toBeUndefined();

    const afterApproval = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authHeaders(registered.token),
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'message',
        body: 'hi again',
      }),
    });
    expect(afterApproval.status).toBe(201);
  });

  it('an agent token cannot answer a gate question (403, needs a deciding human)', async () => {
    const registered = await json<{ address: string; token: string }>(
      await fetch(`${baseUrl}/api/agents/register`, {
        method: 'POST',
        headers: authHeaders(handle.tokens.agentToken),
        body: JSON.stringify({ name: 'gate tester', client: 'codex' }),
      })
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(registered.address)}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );

    const decisions = await json<{
      items: { id: string; data?: { agent?: string } }[];
    }>(await fetch(`${baseUrl}/api/decisions/open`));
    const gate = decisions.items.find(
      (m) => m.data?.agent === registered.address
    );
    expect(gate).toBeDefined();

    const replyRes = await fetch(`${baseUrl}/api/messages/${gate!.id}/reply`, {
      method: 'POST',
      headers: authHeaders(registered.token),
      body: JSON.stringify({ body: 'approve me', choice: 'approve' }),
    });
    expect(replyRes.status).toBe(403);
  });

  it('a retried send with the same Idempotency-Key returns the same message id', async () => {
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'retry-1',
    };
    const body = JSON.stringify({
      to: ['human:test'],
      kind: 'message',
      body: 'hello',
    });

    const first = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.status).toBe(201);
    const firstBody = await json<{ message: { id: string } }>(first);

    const second = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers,
      body,
    });
    expect(second.status).toBe(200);
    const secondBody = await json<{ message: { id: string } }>(second);
    expect(secondBody.message.id).toBe(firstBody.message.id);
  });
});

describe('messaging thread rate limit', () => {
  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-routes-limit-');
    TaskStore.init(root);
    // DeliveryEngine reads this config once, at construction inside
    // startServer — it must exist before the server boots to take effect.
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'messaging:\n  agentTurnsPerThreadPerHour: 1\n'
    );
    executor = new StallingExecutor();
    handle = await startTestServer();
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

  it('too many agent turns in one thread maps to 429', async () => {
    await liveRun('Chatty run');
    const runToken = executor.lastStartOptions?.runToken;

    const first = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authHeaders(runToken!),
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'message',
        body: 'first',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = await json<{ message: { id: string } }>(first);

    const second = await fetch(
      `${baseUrl}/api/messages/${firstBody.message.id}/reply`,
      {
        method: 'POST',
        headers: authHeaders(runToken!),
        body: JSON.stringify({ body: 'second' }),
      }
    );
    expect(second.status).toBe(429);
    const secondBody = await json<{ error: string; field?: string }>(second);
    expect(secondBody.field).toBe('replyTo');
  });
});
