import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface ScopeRequestBody {
  id: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedBy: string | null;
}

interface LedgerEntryBody {
  kind: string;
  title: string;
  detail: string;
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

// Never finishes, so a dispatched run stays `running` — the only state the
// scope-request routes accept a request from.
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-scope-attribution-'));
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
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

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

async function askForScope(runId: string): Promise<string> {
  const record = await json<ScopeRequestBody>(
    await fetch(`${baseUrl}/api/runs/${runId}/scope-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paths: ['packages/core/src/browser.ts'],
        reason: 'the type I need is not exported',
      }),
    })
  );
  return record.id;
}

function decide(
  runId: string,
  requestId: string,
  origin?: string
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/runs/${runId}/scope-requests/${requestId}/decide`,
    {
      method: 'POST',
      headers:
        origin === undefined
          ? { 'content-type': 'application/json' }
          : { 'content-type': 'application/json', origin },
      body: JSON.stringify({ granted: true, reason: 'go ahead' }),
    }
  );
}

describe('a scope decision records who made it', () => {
  it('marks a bare API grant as unattributed, not as a human ruling', async () => {
    const runId = await liveRun('Wants more scope');
    const requestId = await askForScope(runId);

    // Exactly what an agent's own Bash can do: the daemon port is readable
    // from its environment, and this call carries no app origin.
    const decided = await json<ScopeRequestBody>(
      await decide(runId, requestId)
    );
    expect(decided.granted).toBe(true);
    expect(decided.decidedBy).toBe('api');

    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    const entry = ledger.find((e) => e.kind === 'decision');
    expect(entry?.detail).toContain('api');
  });

  it('marks a grant from the app webview as coming from the app', async () => {
    const runId = await liveRun('Wants more scope');
    const requestId = await askForScope(runId);

    const decided = await json<ScopeRequestBody>(
      await decide(runId, requestId, 'tauri://localhost')
    );
    expect(decided.decidedBy).toBe('app');

    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(ledger[0]?.detail).toContain('app');
  });

  it('carries the decider back to the agent parked on the long poll', async () => {
    const runId = await liveRun('Wants more scope');
    const requestId = await askForScope(runId);

    const parked = fetch(
      `${baseUrl}/api/runs/${runId}/scope-requests/${requestId}?wait=1`
    );
    await decide(runId, requestId);
    const answered = await json<ScopeRequestBody>(await parked);
    expect(answered.granted).toBe(true);
    expect(answered.decidedBy).toBe('api');
  });
});
