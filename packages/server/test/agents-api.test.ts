import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { AgentSessionMeta } from '../src/orchestrator/agentSessions.js';
import type { PlanProposal } from '../src/orchestrator/planner.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { FakeWarden } from '../src/orchestrator/wardens/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-agents-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

const SAMPLE_PROPOSAL: PlanProposal = {
  tasks: [
    {
      title: 'Do the thing',
      description: 'Just do it.',
      acceptanceCriteria: ['it is done'],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

let fakeHome: string;
let root: string;
let store: TaskStore;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  store = TaskStore.init(root);
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Boots the daemon with fake conversation backends under 'claude'. Called per
// test (not in beforeEach) so a test can create tasks first — the cache indexes
// what exists at startup, and the enrich route reads tasks through the cache.
async function start(): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerPlanners: (planManager) => {
      planManager.registerPlanner(
        'claude',
        new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
      );
    },
    registerWardens: (wardenManager) => {
      wardenManager.registerBackend('claude', new FakeWarden({ ok: true }));
    },
    registerExecutors: () => {},
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function fetchSessions(): Promise<AgentSessionMeta[]> {
  const res = await fetch(`${baseUrl}/api/agents`);
  expect(res.status).toBe(200);
  return (await json(res)) as AgentSessionMeta[];
}

describe('GET /api/agents', () => {
  it('starts empty', async () => {
    await start();
    expect(await fetchSessions()).toEqual([]);
  });

  it('lists planner, draft and warden conversations with their kinds', async () => {
    await start();
    const planRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan the widget' }),
    });
    expect(planRes.status).toBe(202);

    const draftRes = await fetch(`${baseUrl}/api/tasks/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'draft the widget task' }),
    });
    expect(draftRes.status).toBe(202);

    const wardenRes = await fetch(`${baseUrl}/api/warden`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'what is running?' }),
    });
    expect(wardenRes.status).toBe(202);

    // All three records exist as of their 202s; the fakes settle their turns
    // on a later tick, so wait for `ready` to make the assertion deterministic.
    await waitFor(async () => {
      const sessions = await fetchSessions();
      return (
        sessions.length === 3 && sessions.every((s) => s.state === 'ready')
      );
    });

    const sessions = await fetchSessions();
    const byKind = new Map(sessions.map((s) => [s.kind, s]));
    expect(byKind.get('plan')?.title).toBe('plan the widget');
    expect(byKind.get('draft')?.title).toBe('draft the widget task');
    expect(byKind.get('warden')?.title).toBe('what is running?');
  });

  it('lists a task enrich agent under its task title, not its prompt', async () => {
    const task = store.create({ title: 'Fix the header' });
    await start();

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);

    const sessions = await fetchSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].kind).toBe('enrich');
    expect(sessions[0].title).toBe('Fix the header');
  });
});
