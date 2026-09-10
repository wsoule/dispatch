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

// The scope gate's demotion end to end: a project at rung 2 answers an
// agent's scope request at creation time — granted, attributed to `policy`,
// and recorded in the ledger with the rung that authorized it — while the
// default rung leaves the same request parked for a human.

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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-policy-scope-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// Never calls onFinish, so the dispatched run stays `running` — the only
// state the scope-request routes accept one from.
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
  writeFileSync(join(root, '.dispatch', 'config.yml'), 'policy:\n  rung: 2\n');
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

async function liveRun(
  title: string,
  risk: 'routine' | 'critical' = 'routine'
): Promise<{ runId: string; taskId: string }> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, risk }),
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

function requestScope(
  runId: string,
  paths: string[] = ['packages/core/src/browser.ts']
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/scope-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, reason: 'needs a re-export' }),
  });
}

describe('scope requests under policy rung 2', () => {
  it('auto-accepts at creation, attributed to policy, recorded with the rung', async () => {
    const { runId, taskId } = await liveRun('Auto-accepted scope');
    const res = await requestScope(runId);
    expect(res.status).toBe(201);
    const record = await json<ScopeRequestBody>(res);
    expect(record.granted).toBe(true);
    expect(record.decidedBy).toBe('policy');
    expect(record.decisionReason).toContain('policy rung 2');

    // The grant reaches the ledger like a human's would, carrying the rung.
    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    const entry = ledger.find((e) => e.kind === 'decision');
    expect(entry?.title).toBe(`Scope extended for run ${runId}`);
    expect(entry?.detail).toContain('[decided via policy]');
    expect(entry?.detail).toContain('policy rung 2');

    // And the task's Activity, so the receipt reads next to the work.
    const task = await json<{ body: string }>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(task.body).toContain(`[policy] Scope extended for run ${runId}`);
    expect(task.body).toContain('packages/core/src/browser.ts');
    expect(task.body).toContain('policy rung 2');

    // Already decided: a human's late decision 409s instead of double-ruling.
    const late = await fetch(
      `${baseUrl}/api/runs/${runId}/scope-requests/${record.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: false }),
      }
    );
    expect(late.status).toBe(409);
  });

  // The floor at this gate: a request reaching into .git/ or outside the repo
  // parks for a human even though the rung would auto-grant it, and the feed
  // still lists it as blocking rather than as a recorded auto-decision.
  it('never auto-grants a request outside the repo or into .git', async () => {
    const { runId } = await liveRun('Escaping scope');
    const record = await json<ScopeRequestBody>(
      await requestScope(runId, ['packages/core/src/browser.ts', '.git/config'])
    );
    expect(record.granted).toBeNull();
    expect(record.decidedBy).toBeNull();
    const feed = await json<{ items: { id: string; disposition: string }[] }>(
      await fetch(`${baseUrl}/api/decisions`)
    );
    expect(
      feed.items.find((i) => i.id === `scope-request:${record.id}`)
    ).toMatchObject({ disposition: 'blocking' });
    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(ledger.some((e) => e.title.startsWith('Scope extended'))).toBe(
      false
    );
  });

  it('a block pin on the scope gate re-promotes it over the rung', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 2\n  gates:\n    scope: block\n'
    );
    const { runId } = await liveRun('Pinned back to blocking');
    const record = await json<ScopeRequestBody>(await requestScope(runId));
    expect(record.granted).toBeNull();
    expect(record.decidedBy).toBeNull();
  });

  it('a critical-risk task parks its request for a human, rung or no rung', async () => {
    const { runId } = await liveRun('Publish the package', 'critical');
    const record = await json<ScopeRequestBody>(await requestScope(runId));
    expect(record.granted).toBeNull();
    expect(record.decidedBy).toBeNull();
  });

  it('a path outside the checkout or under .git/ parks the request', async () => {
    const { runId } = await liveRun('Reaching outside');
    for (const paths of [
      ['../other-repo/src/x.ts'],
      ['.git/hooks/pre-commit'],
      ['packages/core/src/browser.ts', '/etc/hosts'],
    ]) {
      const res = await requestScope(runId, paths);
      expect(res.status).toBe(201);
      const record = await json<ScopeRequestBody>(res);
      expect(record.granted).toBeNull();
      expect(record.decidedBy).toBeNull();
    }
    // No auto-grant, so no receipt either.
    const ledger = await json<LedgerEntryBody[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(ledger.filter((e) => e.kind === 'decision')).toEqual([]);
  });
});
