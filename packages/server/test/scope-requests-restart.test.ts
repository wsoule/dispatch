import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, RunMeta } from '../src/orchestrator/types.js';
import { json } from './json.js';
import { initGitRepoAt, StallingExecutor } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Incident 2026-08-23: a run had an undecided scope request open, the user
// relaunched the app, dispatchd restarted, reconcileOnBoot force-failed the
// run, and the request vanished with the process — never re-shown, never
// attached to the resumed run. These pin the fix end to end: the request is
// still there on the failed run after the restart, the decision feed lists
// it, the resume carries it onto the successor (and into that agent's
// prompt), and a request whose run cannot come back is withdrawn rather than
// left as a card nobody can act on.

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

interface ScopeRequestBody {
  id: string;
  runId: string;
  paths: string[];
  granted: boolean | null;
}

interface DecisionItem {
  id: string;
  kind: string;
  runId?: string;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-scope-restart-'));
  initGitRepoAt(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Boots a daemon on `root`, replacing whatever is running there. `quietMs` is
// the recovery sweep's quiet window: tiny to let it resume, huge to hold it
// off so a test can look at the force-failed run before anything moves.
async function boot(executor: Executor, quietMs: number): Promise<string> {
  await handle?.stop();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    },
    autoResumeQuietMs: quietMs,
  });
  useTestAuth(handle);
  return `http://127.0.0.1:${handle.port}`;
}

async function runsOn(baseUrl: string): Promise<RunMeta[]> {
  const runs: RunMeta[] = await json(await fetch(`${baseUrl}/api/runs`));
  return runs;
}

async function successorOf(
  baseUrl: string,
  runId: string
): Promise<RunMeta | undefined> {
  return (await runsOn(baseUrl)).find((r) => r.resumedFrom === runId);
}

async function dispatch(baseUrl: string, taskId: string): Promise<RunMeta> {
  const meta: RunMeta = await json(
    await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  );
  return meta;
}

function requestScope(
  baseUrl: string,
  runId: string,
  paths: string[]
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs/${runId}/scope-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths, reason: 'the export I need lives there' }),
  });
}

async function openRequestsOn(
  baseUrl: string,
  runId: string
): Promise<ScopeRequestBody[]> {
  const open: ScopeRequestBody[] = await json(
    await fetch(`${baseUrl}/api/runs/${runId}/scope-requests`)
  );
  return open;
}

async function scopeDecisions(baseUrl: string): Promise<DecisionItem[]> {
  const body: { items: DecisionItem[] } = await json(
    await fetch(`${baseUrl}/api/decisions`)
  );
  return body.items.filter((item) => item.kind === 'scope-request');
}

async function waitForCrashRecorded(
  baseUrl: string,
  runId: string
): Promise<void> {
  await waitFor(async () => {
    const run = (await runsOn(baseUrl)).find((r) => r.id === runId);
    return run?.state === 'failed' || run?.state === 'interrupted-dirty';
  });
}

describe('a scope request open across a daemon restart', () => {
  it('is still there on the force-failed run, and in the decision feed, after the restart', async () => {
    const store = TaskStore.init(root);
    const task = store.create({
      title: 'Asked for scope, then the daemon died',
    });
    const firstUrl = await boot(new StallingExecutor(), 60_000);
    const lost = await dispatch(firstUrl, task.meta.id);
    const asked: ScopeRequestBody = await json(
      await requestScope(firstUrl, lost.id, ['packages/core/src/browser.ts'])
    );

    // The restart, with the recovery sweep held off so the run stays failed.
    const baseUrl = await boot(new StallingExecutor(), 60_000);
    await waitForCrashRecorded(baseUrl, lost.id);

    const stillOpen = await openRequestsOn(baseUrl, lost.id);
    expect(stillOpen.map((r) => r.id)).toEqual([asked.id]);
    expect(stillOpen[0]?.granted).toBeNull();
    const feed = await scopeDecisions(baseUrl);
    expect(feed.map((item) => item.id)).toEqual([`scope-request:${asked.id}`]);
    expect(feed[0]?.runId).toBe(lost.id);

    // A human can rule on it right there, before anything resumes — and the
    // ruling sticks, so the resumed agent will be told rather than re-asked.
    const decided = await fetch(
      `${baseUrl}/api/runs/${lost.id}/scope-requests/${asked.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true, reason: 'go ahead' }),
      }
    );
    expect(decided.status).toBe(200);
    expect(await openRequestsOn(baseUrl, lost.id)).toEqual([]);
    expect(await scopeDecisions(baseUrl)).toEqual([]);
  });

  it('follows the run into its resumed successor, prompt included, and re-attaches on a repeat request', async () => {
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Resumed with the request in tow' });
    const firstUrl = await boot(new StallingExecutor(), 40);
    const lost = await dispatch(firstUrl, task.meta.id);
    const paths = [
      'packages/core/src/browser.ts',
      'packages/core/src/index.ts',
    ];
    const asked: ScopeRequestBody = await json(
      await requestScope(firstUrl, lost.id, paths)
    );

    const after = new StallingExecutor();
    const baseUrl = await boot(after, 40);
    await waitFor(
      async () => (await successorOf(baseUrl, lost.id)) !== undefined
    );
    const successor = (await successorOf(baseUrl, lost.id))!;

    // Same request, same id, new owner — and gone from the run that died.
    const carried = await openRequestsOn(baseUrl, successor.id);
    expect(carried.map((r) => r.id)).toEqual([asked.id]);
    expect(carried[0]?.runId).toBe(successor.id);
    expect(await openRequestsOn(baseUrl, lost.id)).toEqual([]);
    expect((await scopeDecisions(baseUrl))[0]?.runId).toBe(successor.id);

    // The resumed agent is told what it was waiting on, by id.
    const prompt = after.started[0]?.prompt ?? '';
    expect(prompt).toContain('## Scope requests from before the restart');
    expect(prompt).toContain(asked.id);
    expect(prompt).toContain('Still awaiting a decision');

    // Re-issuing the request (what the prompt tells the agent to do) re-parks
    // on the carried record instead of putting a second card in front of the
    // human: 200 and the same id, in any path order.
    const again = await requestScope(
      baseUrl,
      successor.id,
      [...paths].reverse()
    );
    expect(again.status).toBe(200);
    expect(((await json(again)) as ScopeRequestBody).id).toBe(asked.id);
    expect(await openRequestsOn(baseUrl, successor.id)).toHaveLength(1);

    // And the ruling lands against the successor.
    const decided = await fetch(
      `${baseUrl}/api/runs/${successor.id}/scope-requests/${asked.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: false }),
      }
    );
    expect(decided.status).toBe(200);
    expect(await openRequestsOn(baseUrl, successor.id)).toEqual([]);
  });

  it('carries a ruling made on the dead run into the successor prompt as decided, not pending', async () => {
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Decided before the resume' });
    const firstUrl = await boot(new StallingExecutor(), 60_000);
    const lost = await dispatch(firstUrl, task.meta.id);
    const asked: ScopeRequestBody = await json(
      await requestScope(firstUrl, lost.id, ['packages/core/src/browser.ts'])
    );
    await fetch(
      `${firstUrl}/api/runs/${lost.id}/scope-requests/${asked.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          granted: true,
          reason: 'the re-export is fine',
        }),
      }
    );

    const after = new StallingExecutor();
    const baseUrl = await boot(after, 40);
    await waitFor(
      async () => (await successorOf(baseUrl, lost.id)) !== undefined
    );

    const prompt = after.started[0]?.prompt ?? '';
    expect(prompt).toContain(asked.id);
    expect(prompt).toContain('**GRANTED');
    expect(prompt).toContain('the re-export is fine');
    expect(prompt).not.toContain('Still awaiting a decision');
    const successor = (await successorOf(baseUrl, lost.id))!;
    expect(await openRequestsOn(baseUrl, successor.id)).toEqual([]);
  });

  it('withdraws the request at boot when the run cannot be resumed', async () => {
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Worktree gone with the restart' });
    const firstUrl = await boot(new StallingExecutor(), 60_000);
    const lost = await dispatch(firstUrl, task.meta.id);
    const asked: ScopeRequestBody = await json(
      await requestScope(firstUrl, lost.id, ['packages/core/src/browser.ts'])
    );
    await handle?.stop();
    handle = undefined;
    // No worktree means no successor can ever pick the request up.
    rmSync(lost.worktreePath, { recursive: true, force: true });

    const baseUrl = await boot(new StallingExecutor(), 60_000);
    await waitForCrashRecorded(baseUrl, lost.id);

    expect(await openRequestsOn(baseUrl, lost.id)).toEqual([]);
    expect(await scopeDecisions(baseUrl)).toEqual([]);
    const fetched = await fetch(
      `${baseUrl}/api/runs/${lost.id}/scope-requests/${asked.id}`
    );
    expect(fetched.status).toBe(404);
  });
});
