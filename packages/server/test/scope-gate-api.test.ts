import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { initGitRepo, StallingExecutor } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The daemon's own wiring of scope gates: at rung 2 a run's scope gate is
// granted by Dispatch, recorded in the ledger and in the task's Activity. On
// sqlite, so a grant written to the default JSONL ledger never reaches the API.

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

interface AnswerBody {
  answer: {
    from: string;
    choice?: string;
    body: string;
    data?: { type?: string };
  } | null;
}

interface LedgerEntryBody {
  kind: string;
  title: string;
  detail: string;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let executor: StallingExecutor;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-scope-gate-');
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'config.yml'), 'policy:\n  rung: 2\n');
  executor = new StallingExecutor();
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    storeBackend: 'sqlite',
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
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

// Dispatches a task and waits for its run to be `running`, so the run's
// minted token (executor.lastRunToken) is settled.
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

describe('scope gates under policy rung 2', () => {
  it('Dispatch grants the gate and records it in the ledger and the Activity', async () => {
    const { runId, taskId } = await liveRun('Auto-granted scope');
    const runToken = executor.lastRunToken;
    expect(runToken).toBeDefined();

    const sendRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: authHeaders(runToken!),
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'question',
        blocking: true,
        choices: ['grant', 'deny'],
        body: 'I need browser.ts',
        data: {
          type: 'scope',
          paths: ['packages/core/src/browser.ts'],
          reason: 'needs a re-export',
        },
      }),
    });
    expect(sendRes.status).toBe(201);
    const { message } = await json<{ message: { id: string } }>(sendRes);

    let answer: AnswerBody['answer'] = null;
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/messages/${message.id}/answer`, {
        headers: authHeaders(runToken!),
      });
      answer = (await json<AnswerBody>(res)).answer;
      return answer !== null;
    });
    expect(answer).toMatchObject({
      from: 'agent:dispatch',
      choice: 'grant',
      data: { type: 'x-policy' },
    });

    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    const decisions = ledger.filter(
      (e) =>
        e.kind === 'decision' && e.title === `Scope extended for run ${runId}`
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].detail).toContain('policy rung 2');
    expect(decisions[0].detail).toEndWith(`[gate ${message.id}]`);

    const task = await json<{ body: string }>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(task.body).toContain(`[policy] Scope extended for run ${runId}`);
    expect(task.body).toContain('packages/core/src/browser.ts');
  });
});
