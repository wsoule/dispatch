import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DecisionItem } from '../src/decisionFeed.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { json } from './json.js';
import { initGitRepo } from './orchestrator/helpers.js';
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
};

// Never calls onFinish, so a dispatched run sits in `running` for as long as
// the test needs — the state the question and scope-request routes require.
const controllable: Executor = {
  start: () => noopRun,
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
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-decisions-api-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
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

async function liveRun(title: string): Promise<string> {
  const runId = await dispatchRun(await createTask(title), 'claude');
  await waitFor(async () => {
    const r = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
    return r.meta.state === 'running';
  });
  return runId;
}

function decisions(query = ''): Promise<DecisionItem[]> {
  return fetch(`${baseUrl}/api/decisions${query}`)
    .then((r) => json(r) as Promise<{ items: DecisionItem[] }>)
    .then((body) => body.items);
}

describe('GET /api/decisions', () => {
  it('is empty on a project where nothing is waiting', async () => {
    expect(await decisions()).toEqual([]);
  });

  it('reports an open question with its run and task reference', async () => {
    const runId = await liveRun('Ask something');
    const asked = await json(
      await fetch(`${baseUrl}/api/runs/${runId}/questions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Which database?' }),
      })
    );

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('question');
    expect(items[0].id).toBe(`question:${asked.id}`);
    expect(items[0].runId).toBe(runId);
    expect(items[0].taskTitle).toBe('Ask something');
    expect(items[0].summary).toBe('Which database?');
    expect(items[0].state).toBe('open');
    expect(items[0].disposition).toBe('blocking');
    expect(items[0].ageMs).toBeGreaterThanOrEqual(0);
  });

  it('drops an answered question and shows it resolved on request', async () => {
    const runId = await liveRun('Ask something');
    const asked = await json(
      await fetch(`${baseUrl}/api/runs/${runId}/questions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Which database?' }),
      })
    );
    expect(await decisions()).toHaveLength(1);

    const answered = await fetch(
      `${baseUrl}/api/runs/${runId}/questions/${asked.id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'sqlite' }),
      }
    );
    expect(answered.status).toBe(200);

    expect(await decisions()).toEqual([]);
    const withResolved = await decisions('?resolved=1');
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0].state).toBe('resolved');
    expect(withResolved[0].resolvedAt).toBeString();
  });

  it('reports an undecided scope request and drops it once decided', async () => {
    const runId = await liveRun('Needs a shared export');
    const requested = await json(
      await fetch(`${baseUrl}/api/runs/${runId}/scope-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paths: ['packages/core/src/browser.ts'],
          reason: 'the type my scoped code needs is not re-exported',
        }),
      })
    );

    const items = await decisions();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('scope-request');
    expect(items[0].id).toBe(`scope-request:${requested.id}`);
    expect(items[0].summary).toContain('packages/core/src/browser.ts');
    expect(items[0].reason).toBe(
      'the type my scoped code needs is not re-exported'
    );

    await fetch(
      `${baseUrl}/api/runs/${runId}/scope-requests/${requested.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true }),
      }
    );
    expect(await decisions()).toEqual([]);
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
    const runId = await liveRun('Ask something');
    await fetch(`${baseUrl}/api/runs/${runId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Which database?' }),
    });

    expect(await decisions('?disposition=blocking')).toHaveLength(1);
    expect(await decisions('?disposition=recorded')).toEqual([]);

    const bad = await fetch(`${baseUrl}/api/decisions?disposition=maybe`);
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({
      error: expect.stringContaining('disposition'),
    });
  });
});

describe('decisions.changed over /ws', () => {
  it('fires when something starts awaiting a human', async () => {
    const runId = await liveRun('Ask something');
    const ws = new WebSocket(wsUrl(handle));
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (event) => {
      seen.push((JSON.parse(String(event.data)) as { type: string }).type);
    };

    await fetch(`${baseUrl}/api/runs/${runId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Which database?' }),
    });
    await waitFor(() => seen.includes('decisions.changed'));
    ws.close();
  });
});
