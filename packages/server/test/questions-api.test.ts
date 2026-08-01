import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';

// Response.json() types as Promise<unknown> under this repo's DOM-less
// tsconfig, so every read names the shape it expects.
function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface Entry {
  kind: string;
  from?: string;
  toUser?: boolean;
  text?: string;
}

interface QuestionBody {
  id: string;
  runId: string;
  options: string[];
  answer: string | null;
}

async function waitFor(
  check: () => Promise<boolean>,
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

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-questions-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// Never calls onFinish, so a dispatched run sits in `running` for as long as
// the test needs — the only state the questions routes accept an ask from.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      send: () => {},
      approve: () => {},
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
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
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

// Dispatches a task and waits for its run to actually be `running`.
async function liveRun(title: string): Promise<string> {
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
  return meta.id;
}

function ask(
  runId: string,
  question: string,
  options?: string[]
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      options === undefined ? { question } : { question, options }
    ),
  });
}

function openQuestions(): Promise<QuestionBody[]> {
  return fetch(`${baseUrl}/api/questions`).then((r) => json<QuestionBody[]>(r));
}

function answer(
  runId: string,
  questionId: string,
  text: string
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/questions/${questionId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: text }),
  });
}

describe('POST /api/runs/:id/questions', () => {
  it('201s, writes the question to the transcript, and lists it as open', async () => {
    const runId = await liveRun('Ask something');
    const res = await ask(runId, 'Which database?', ['sqlite', 'postgres']);
    expect(res.status).toBe(201);
    const record = await json<QuestionBody>(res);
    expect(record.id).toMatch(/^q-[0-9a-f]{6}$/);
    expect(record.answer).toBeNull();
    expect(record.options).toEqual(['sqlite', 'postgres']);

    const detail = await json<{ entries: Entry[] }>(
      await fetch(`${baseUrl}/api/runs/${runId}`)
    );
    const asked = detail.entries.find(
      (e) => e.kind === 'message' && e.toUser === true
    );
    expect(asked?.from).toBe('agent');
    expect(asked?.text).toContain('Which database?');
    expect(asked?.text).toContain('- postgres');

    const open = await json<QuestionBody[]>(
      await fetch(`${baseUrl}/api/questions`)
    );
    expect(open).toHaveLength(1);
    expect(open[0].runId).toBe(runId);
  });

  it('400s a missing question and 404s an unknown run', async () => {
    const runId = await liveRun('Validation');
    const empty = await ask(runId, '   ');
    expect(empty.status).toBe(400);

    const badOptions = await fetch(`${baseUrl}/api/runs/${runId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hi', options: [1, 2] }),
    });
    expect(badOptions.status).toBe(400);

    const unknown = await ask('r-000000', 'hi');
    expect(unknown.status).toBe(404);
  });
});

describe('GET /api/runs/:id/questions/:qid', () => {
  it('parks with ?wait=1 and returns the moment an answer lands', async () => {
    const runId = await liveRun('Long poll');
    const record = await json<QuestionBody>(
      await ask(runId, 'Which database?')
    );

    const started = Date.now();
    const polling = fetch(
      `${baseUrl}/api/runs/${runId}/questions/${record.id}?wait=1`
    ).then((r) => json<QuestionBody>(r));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await answer(runId, record.id, 'postgres')).toHaveProperty(
      'status',
      200
    );

    const polled = await polling;
    expect(polled.answer).toBe('postgres');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('404s a question id that belongs to a different run', async () => {
    const first = await liveRun('Owner');
    const second = await liveRun('Impostor');
    const record = await json<QuestionBody>(
      await ask(first, 'Which database?')
    );

    const res = await fetch(
      `${baseUrl}/api/runs/${second}/questions/${record.id}`
    );
    expect(res.status).toBe(404);
    expect((await answer(second, record.id, 'postgres')).status).toBe(404);
  });
});

describe('POST /api/runs/:id/questions/:qid/answer', () => {
  it('records the answer on the transcript and 409s a second one', async () => {
    const runId = await liveRun('Answer once');
    const record = await json<QuestionBody>(
      await ask(runId, 'Which database?')
    );

    expect((await answer(runId, record.id, 'postgres')).status).toBe(200);
    expect((await answer(runId, record.id, 'sqlite')).status).toBe(409);

    const detail = await json<{ entries: Entry[] }>(
      await fetch(`${baseUrl}/api/runs/${runId}`)
    );
    const reply = detail.entries.find(
      (e) => e.kind === 'message' && e.from === 'user'
    );
    expect(reply?.text).toBe('postgres');
    expect(await openQuestions()).toEqual([]);
  });
});

describe('DELETE /api/runs/:id/questions/:qid', () => {
  it('withdraws the question so nothing can answer it any more', async () => {
    const runId = await liveRun('Withdraw');
    const record = await json<QuestionBody>(
      await ask(runId, 'Which database?')
    );

    const res = await fetch(
      `${baseUrl}/api/runs/${runId}/questions/${record.id}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(204);
    expect(await openQuestions()).toEqual([]);
    expect((await answer(runId, record.id, 'postgres')).status).toBe(404);
  });
});

describe('a run going terminal', () => {
  it('closes its open questions', async () => {
    const runId = await liveRun('Cancelled mid-question');
    await ask(runId, 'Which database?');
    expect(await openQuestions()).toHaveLength(1);

    await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: 'POST' });
    await waitFor(async () => (await openQuestions()).length === 0);
  });
});
