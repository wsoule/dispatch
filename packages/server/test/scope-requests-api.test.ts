import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

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

interface ScopeRequestBody {
  id: string;
  runId: string;
  paths: string[];
  reason: string;
  granted: boolean | null;
  decisionReason: string | null;
}

interface LedgerEntryBody {
  kind: string;
  sourceTaskId: string | null;
  title: string;
  detail: string;
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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-scope-requests-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// Never calls onFinish, so a dispatched run sits in `running` for as long as
// the test needs — the only state the scope-request routes accept one from.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      requestStop: () => {},
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

function requestScope(
  runId: string,
  paths: string[] | undefined,
  reason: string | undefined
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/scope-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, reason }),
  });
}

function decide(
  runId: string,
  requestId: string,
  granted: boolean,
  reason?: string
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/runs/${runId}/scope-requests/${requestId}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        reason === undefined ? { granted } : { granted, reason }
      ),
    }
  );
}

describe('POST /api/runs/:id/scope-requests', () => {
  it('201s, writes the request to the transcript, and reads back undecided', async () => {
    const runId = await liveRun('Needs a shared export');
    const res = await requestScope(
      runId,
      ['packages/core/src/browser.ts'],
      'browser.ts never re-exports the type my scoped code needs'
    );
    expect(res.status).toBe(201);
    const record = await json<ScopeRequestBody>(res);
    expect(record.id).toMatch(/^sr-[0-9a-f]{6}$/);
    expect(record.granted).toBeNull();
    expect(record.paths).toEqual(['packages/core/src/browser.ts']);

    const detail = await json<{ entries: Entry[] }>(
      await fetch(`${baseUrl}/api/runs/${runId}`)
    );
    const asked = detail.entries.find(
      (e) => e.kind === 'message' && e.toUser === true
    );
    expect(asked?.from).toBe('agent');
    expect(asked?.text).toContain('browser.ts');

    const fetched = await json<ScopeRequestBody>(
      await fetch(`${baseUrl}/api/runs/${runId}/scope-requests/${record.id}`)
    );
    expect(fetched.granted).toBeNull();
  });

  it('400s missing paths/reason and 404s an unknown run', async () => {
    const runId = await liveRun('Validation');
    expect((await requestScope(runId, [], 'why')).status).toBe(400);
    expect((await requestScope(runId, ['a.ts'], '   ')).status).toBe(400);
    expect((await requestScope('r-000000', ['a.ts'], 'why')).status).toBe(404);
  });
});

describe('GET /api/runs/:id/scope-requests/:rid', () => {
  it('parks with ?wait=1 and returns the moment a decision lands', async () => {
    const runId = await liveRun('Long poll');
    const record = await json<ScopeRequestBody>(
      await requestScope(runId, ['a.ts'], 'why')
    );

    const started = Date.now();
    const polling = fetch(
      `${baseUrl}/api/runs/${runId}/scope-requests/${record.id}?wait=1`
    ).then((r) => json<ScopeRequestBody>(r));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await decide(runId, record.id, true)).toHaveProperty('status', 200);

    const polled = await polling;
    expect(polled.granted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('404s a request id that belongs to a different run', async () => {
    const first = await liveRun('Owner');
    const second = await liveRun('Impostor');
    const record = await json<ScopeRequestBody>(
      await requestScope(first, ['a.ts'], 'why')
    );

    const res = await fetch(
      `${baseUrl}/api/runs/${second}/scope-requests/${record.id}`
    );
    expect(res.status).toBe(404);
    expect((await decide(second, record.id, true)).status).toBe(404);
  });
});

describe('POST /api/runs/:id/scope-requests/:rid/decide', () => {
  it('grants and appends a decision ledger entry, then 409s a second decision', async () => {
    const runId = await liveRun('Grant once');
    const record = await json<ScopeRequestBody>(
      await requestScope(runId, ['a.ts'], 'why')
    );

    const res = await decide(runId, record.id, true, 'looks safe');
    expect(res.status).toBe(200);
    const decided = await json<ScopeRequestBody>(res);
    expect(decided.granted).toBe(true);
    expect(decided.decisionReason).toBe('looks safe');
    expect((await decide(runId, record.id, false)).status).toBe(409);

    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    const entry = ledger.find((e) => e.kind === 'decision');
    expect(entry?.detail).toContain('a.ts');
    expect(entry?.detail).toContain('why');
  });

  it('denies without touching the ledger', async () => {
    const runId = await liveRun('Deny once');
    const record = await json<ScopeRequestBody>(
      await requestScope(runId, ['a.ts'], 'why')
    );

    const res = await decide(runId, record.id, false, 'too risky');
    expect(res.status).toBe(200);
    const decided = await json<ScopeRequestBody>(res);
    expect(decided.granted).toBe(false);

    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(ledger.find((e) => e.kind === 'decision')).toBeUndefined();
  });
});

describe('a run going terminal', () => {
  it('closes its own open scope requests', async () => {
    const runId = await liveRun('Cancelled mid-request');
    const record = await json<ScopeRequestBody>(
      await requestScope(runId, ['a.ts'], 'why')
    );

    await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: 'POST' });
    await waitFor(async () => {
      const res = await fetch(
        `${baseUrl}/api/runs/${runId}/scope-requests/${record.id}`
      );
      return res.status === 404;
    });
  });
});
