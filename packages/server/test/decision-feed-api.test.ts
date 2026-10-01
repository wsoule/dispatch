import { TaskStore } from '@dispatch/core';
import type { Message } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DecisionItem } from '../src/decisionFeed.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { json } from './json.js';
import { ParkingExecutor } from './messaging/harness.js';
import { initGitRepo, StallingExecutor } from './orchestrator/helpers.js';
import { useTestAuth, wsUrl } from './testAuth.js';

// Accepts a sync or async predicate: some of these poll an HTTP route, others
// just look at what the WebSocket has already delivered.
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

const noopRun: ExecutorRun = {
  interrupt: async () => {},
  requestStop: () => {},
  send: () => {},
  approve: () => {},
  notify: () => {},
};

// Fails as soon as it starts, so a run reaches the `failed` state the feed
// reports as a stalled run.
const failing: Executor = {
  start(_opts, events) {
    queueMicrotask(() => {
      events.onFinish({ state: 'failed', error: 'executor blew up' });
    });
    return noopRun;
  },
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
// Holds its runs open and hands out their tokens, so a test can send as a run.
let stalling: StallingExecutor;
// Parks a run on a tool call when the test says so, raising a real gate.
let parking: ParkingExecutor;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-decisions-api-');
  TaskStore.init(root);
  stalling = new StallingExecutor();
  parking = new ParkingExecutor();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', stalling);
      orchestrator.registerExecutor('parking', parking);
      orchestrator.registerExecutor('failing', failing);
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

async function createTask(title: string): Promise<string> {
  const task: { meta: { id: string } } = await json(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  return task.meta.id;
}

async function dispatchRun(taskId: string, executor: string): Promise<string> {
  const meta: { id: string } = await json(
    await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor }),
    })
  );
  return meta.id;
}

async function liveRun(
  title: string,
  executor = 'claude'
): Promise<{ runId: string; taskId: string }> {
  const taskId = await createTask(title);
  const runId = await dispatchRun(taskId, executor);
  await waitFor(async () => {
    const r = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
    return r.meta.state === 'running';
  });
  return { runId, taskId };
}

function decisions(query = ''): Promise<DecisionItem[]> {
  return fetch(`${baseUrl}/api/decisions${query}`)
    .then((r) => json(r) as Promise<{ items: DecisionItem[] }>)
    .then((body) => body.items);
}

// Sends a blocking question to a human as the live run's own token, the way an
// agent's msg_send does, and returns the stored message id.
async function askAsRun(
  body: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const token = stalling.lastRunToken;
  if (token === undefined) throw new Error('no run token minted');
  const res = await fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: ['human:test'],
      kind: 'question',
      blocking: true,
      body,
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const sent: { message: { id: string } } = await json(res);
  return sent.message.id;
}

// A run's scope request, exactly as the protocol requires it.
function requestScope(paths: string[], reason: string): Promise<string> {
  return askAsRun(`I need ${paths.join(', ')}`, {
    choices: ['grant', 'deny'],
    data: { type: 'scope', paths, reason },
  });
}

// Answers a gate as the app token's deciding human.
async function reply(messageId: string, choice: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'decided', choice }),
  });
  expect(res.status).toBe(201);
}

// Parks the parking executor's live run on a Bash call and returns the gate
// that the park raised.
async function parkForApproval(): Promise<Message> {
  parking.park('req-1', 'Bash', { command: 'pnpm install' });
  let gate: Message | undefined;
  await waitFor(async () => {
    const open: { items: Message[] } = await json(
      await fetch(`${baseUrl}/api/decisions/open`)
    );
    gate = open.items.find(
      (m) => (m.data as { type?: string } | undefined)?.type === 'tool-approval'
    );
    return gate !== undefined;
  });
  return gate!;
}

describe('GET /api/decisions', () => {
  it('is empty on a project where nothing is waiting', async () => {
    expect(await decisions()).toEqual([]);
  });

  it('lists a parked tool call as an approval, and resolves it once answered', async () => {
    const { runId, taskId } = await liveRun('Needs a shell', 'parking');
    const gate = await parkForApproval();

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `approval:${gate.id}`,
      kind: 'approval',
      runId,
      taskId,
      taskTitle: 'Needs a shell',
      summary: 'Needs a shell: agent is waiting for permission to use Bash',
      state: 'open',
      disposition: 'blocking',
    });

    await reply(gate.id, 'approve');
    await waitFor(() => parking.decisions.length === 1);
    expect(parking.decisions[0]).toEqual({
      requestId: 'req-1',
      decision: { allow: true, scope: 'once' },
    });
    expect(await decisions()).toEqual([]);
    const withResolved = await decisions('?resolved=1');
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0]).toMatchObject({
      id: `approval:${gate.id}`,
      state: 'resolved',
    });
  });

  it('reports an open question with its run and task reference', async () => {
    const { runId } = await liveRun('Ask something');
    const questionId = await askAsRun('Which database?');

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('question');
    expect(items[0].id).toBe(`question:${questionId}`);
    expect(items[0].runId).toBe(runId);
    expect(items[0].taskTitle).toBe('Ask something');
    expect(items[0].summary).toBe('Which database?');
    expect(items[0].state).toBe('open');
    expect(items[0].disposition).toBe('blocking');
    expect(items[0].ageMs).toBeGreaterThanOrEqual(0);
  });

  it('drops an answered question and shows it resolved on request', async () => {
    await liveRun('Ask something');
    const questionId = await askAsRun('Which database?', {
      choices: ['sqlite', 'postgres'],
    });
    expect(await decisions()).toHaveLength(1);

    await reply(questionId, 'sqlite');

    expect(await decisions()).toEqual([]);
    const withResolved = await decisions('?resolved=1');
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0].state).toBe('resolved');
    expect(withResolved[0].resolvedAt).toBeString();
  });

  it('reports an undecided scope gate and drops it once decided', async () => {
    await liveRun('Needs a shared export');
    const gateId = await requestScope(
      ['packages/core/src/browser.ts'],
      'the type my scoped code needs is not re-exported'
    );

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('scope-request');
    expect(items[0].id).toBe(`scope-request:${gateId}`);
    expect(items[0].summary).toContain('packages/core/src/browser.ts');
    expect(items[0].paths).toEqual(['packages/core/src/browser.ts']);
    expect(items[0].reason).toBe(
      'the type my scoped code needs is not re-exported'
    );

    await reply(gateId, 'grant');
    expect(await decisions()).toEqual([]);
  });

  // A request into .git/ is the floor at this gate: it parks for a human at
  // any rung, and the feed lists it as blocking, not recorded.
  it('lists a rung-2 scope gate into .git as blocking and never auto-grants it', async () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 2\n'
    );
    await liveRun('Escaping scope');
    const gateId = await requestScope(
      ['packages/core/src/browser.ts', '.git/config'],
      'needs both'
    );

    const feed = await decisions();
    expect(feed.find((i) => i.id === `scope-request:${gateId}`)).toMatchObject({
      disposition: 'blocking',
    });
    const answer: { answer: Message | null } = await json(
      await fetch(`${baseUrl}/api/messages/${gateId}/answer`)
    );
    expect(answer.answer).toBeNull();
    const ledger: { title: string }[] = await json(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(ledger.some((e) => e.title.startsWith('Scope extended'))).toBe(
      false
    );
  });

  it('reports a run that failed and was never reviewed as stalled', async () => {
    const taskId = await createTask('This one dies');
    const runId = await dispatchRun(taskId, 'failing');
    await waitFor(async () => (await decisions()).length > 0);

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('run-stalled');
    expect(items[0].id).toBe(`run-stalled:${runId}`);
    expect(items[0].taskId).toBe(taskId);
    expect(items[0].reason).toBeString();
  });

  it('filters on disposition and rejects an unknown one', async () => {
    await liveRun('Ask something');
    await askAsRun('Which database?');

    expect(await decisions('?disposition=blocking')).toHaveLength(1);
    expect(await decisions('?disposition=recorded')).toEqual([]);

    const bad = await fetch(`${baseUrl}/api/decisions?disposition=maybe`);
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({
      error: expect.stringContaining('disposition'),
    });
  });
});

describe('tool approvals under policy rung 3', () => {
  it('Dispatch answers the gate itself and the parked call runs', async () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 3\n'
    );
    await liveRun('Needs a shell', 'parking');
    parking.park('req-1', 'Bash', { command: 'pnpm install' });
    await waitFor(() => parking.decisions.length === 1);
    expect(parking.decisions[0]).toEqual({
      requestId: 'req-1',
      decision: { allow: true, scope: 'once' },
    });
    const [item] = await decisions('?resolved=1');
    const gateId = item?.id.slice('approval:'.length) ?? '';
    const answer: {
      answer: { from: string; data?: { type?: string } } | null;
    } = await json(await fetch(`${baseUrl}/api/messages/${gateId}/answer`));
    expect(answer.answer).toMatchObject({
      from: 'agent:dispatch',
      data: { type: 'x-policy' },
    });
  });
});

describe('GET /api/runs/:id/approvals/:requestId', () => {
  it("returns a parked floor call's full input, which its cut gate flags", async () => {
    const { runId } = await liveRun('Push it', 'parking');
    const command = `${' '.repeat(9000)}; git push --force origin main`;
    parking.park('req-1', 'Bash', { command });
    let gate: Message | undefined;
    await waitFor(async () => {
      const open: { items: Message[] } = await json(
        await fetch(`${baseUrl}/api/decisions/open`)
      );
      gate = open.items[0];
      return gate !== undefined;
    });
    expect(gate?.data).toMatchObject({ truncated: true, floor: true });
    expect(JSON.stringify(gate?.data)).not.toContain('git push');

    const res = await fetch(`${baseUrl}/api/runs/${runId}/approvals/req-1`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ tool: 'Bash', input: { command } });
    const [item] = await decisions();
    expect(item).toMatchObject({
      floor: 'force-push',
      disposition: 'blocking',
    });
  });

  it('404s a request the run is not parked on, and refuses the agent token', async () => {
    const { runId } = await liveRun('Needs a shell', 'parking');
    await parkForApproval();

    const missing = await fetch(`${baseUrl}/api/runs/${runId}/approvals/req-9`);
    expect(missing.status).toBe(404);
    const asAgent = await fetch(
      `${baseUrl}/api/runs/${runId}/approvals/req-1`,
      { headers: { authorization: `Bearer ${handle.tokens.agentToken}` } }
    );
    expect(asAgent.status).toBe(403);
  });
});

describe('gates across a daemon restart', () => {
  it("closes a dead run's approval but keeps an execute run's scope gate open", async () => {
    await liveRun('Needs a shell', 'parking');
    const approval = await parkForApproval();
    await liveRun('Needs scope');
    const scopeId = await requestScope(['a.ts'], 'needs the helper');

    await handle.stop();
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', new StallingExecutor());
        orchestrator.registerExecutor('parking', new ParkingExecutor());
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const open: { items: Message[] } = await json(
      await fetch(`${baseUrl}/api/decisions/open`)
    );
    expect(open.items.map((m) => m.id)).toEqual([scopeId]);
    expect(
      (await decisions()).filter((i) => i.kind !== 'run-stalled')
    ).toMatchObject([
      { id: `scope-request:${scopeId}`, kind: 'scope-request' },
    ]);
    const answer: { answer: { data?: { type?: string } } | null } = await json(
      await fetch(`${baseUrl}/api/messages/${approval.id}/answer`)
    );
    expect(answer.answer?.data?.type).toBe('x-closed');
  });
});

describe('decisions.changed over /ws', () => {
  it('fires when a gate opens and again when it is answered', async () => {
    await liveRun('Needs a shell', 'parking');
    const ws = new WebSocket(wsUrl(handle));
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (event) => {
      seen.push((JSON.parse(String(event.data)) as { type: string }).type);
    };
    const changes = () => seen.filter((t) => t === 'decisions.changed').length;

    const gate = await parkForApproval();
    await waitFor(() => changes() >= 1);
    const opened = changes();

    await reply(gate.id, 'deny');
    await waitFor(() => changes() > opened);
    ws.close();
  });
});
