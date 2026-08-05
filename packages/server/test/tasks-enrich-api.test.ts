import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { PlanRecord } from '../src/orchestrator/plan.js';
import type {
  Planner,
  PlannerTurn,
  PlanProposal,
} from '../src/orchestrator/planner.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-tasks-enrich-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// Records the prompt it was handed, so "the task's own text actually reaches
// the planner" is an assertion rather than an assumption.
class RecordingPlanner implements Planner {
  prompts: string[] = [];

  constructor(private readonly proposal: PlanProposal) {}

  start(prompt: string): Promise<PlannerTurn> {
    this.prompts.push(prompt);
    return Promise.resolve({
      reply: 'drafted a task',
      proposal: this.proposal,
      questions: [],
      sessionId: '1',
    });
  }

  sendMessage(
    _sessionId: string | undefined,
    message: string
  ): Promise<PlannerTurn> {
    this.prompts.push(message);
    return Promise.resolve({
      reply: 'refined',
      proposal: this.proposal,
      questions: [],
      sessionId: '2',
    });
  }
}

const DRAFTED_TASK: PlanProposal = {
  tasks: [
    {
      title: 'Make the daemon survive a mid-write crash',
      description:
        'packages/server/src/inbox.ts rewrites the whole file in place.',
      acceptanceCriteria: ['A crash mid-write leaves the inbox parseable'],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let planner: RecordingPlanner;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  planner = new RecordingPlanner(DRAFTED_TASK);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    // Registered as 'claude' because that is the planner the enrich endpoint
    // asks for; the real ClaudePlanner is never constructed in CI.
    registerPlanners: (planManager) => {
      planManager.registerPlanner('claude', planner);
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

async function createTask(
  title: string,
  description?: string
): Promise<{ meta: { id: string; status: string }; body: string }> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  expect(res.status).toBe(201);
  return (await json(res)) as {
    meta: { id: string; status: string };
    body: string;
  };
}

async function waitForReadyPlan(planId: string): Promise<PlanRecord> {
  await waitFor(async () => {
    const r = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
    return r.state !== 'running';
  });
  return (await json(
    await fetch(`${baseUrl}/api/plan/${planId}`)
  )) as PlanRecord;
}

describe('POST /api/tasks/:id/enrich', () => {
  it('starts a plan carrying the task title and its current body', async () => {
    const task = await createTask(
      'inbox writes are not crash-safe',
      'we rewrite the file in place'
    );

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const { planId } = await json(res);

    const record = await waitForReadyPlan(planId);
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(DRAFTED_TASK);

    expect(planner.prompts).toHaveLength(1);
    expect(planner.prompts[0]).toContain('inbox writes are not crash-safe');
    expect(planner.prompts[0]).toContain('we rewrite the file in place');
    // Deepening one existing task, never fanning it out into an epic.
    expect(planner.prompts[0]).toContain('exactly ONE task');
    expect(planner.prompts[0]).toContain('PRESERVE');
  });

  it('says so when the task has no description yet', async () => {
    const task = await createTask('inbox writes are not crash-safe');

    const { planId } = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
        method: 'POST',
      })
    );
    await waitForReadyPlan(planId);

    expect(planner.prompts[0]).toContain('no description at all');
  });

  // sourceNoteId is what confirmPlan reads to mark a note promoted — a task id there sends it
  // into the note store with an id that store never owns.
  it('does not tag the plan with a sourceNoteId', async () => {
    const task = await createTask('inbox writes are not crash-safe');

    const { planId } = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
        method: 'POST',
      })
    );
    const record = await waitForReadyPlan(planId);

    expect(record.sourceNoteId).toBeUndefined();
  });

  it('writes nothing to the task until the draft is applied', async () => {
    const task = await createTask(
      'inbox writes are not crash-safe',
      'we rewrite the file in place'
    );

    const { planId } = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
        method: 'POST',
      })
    );
    await waitForReadyPlan(planId);

    const after = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(after.body).toBe(task.body);
    const tasks = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasks).toHaveLength(1);
  });

  it('404s an unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-nope/enrich`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

// The other half of the round trip: the app PATCHes the drafted sections onto the task rather
// than confirming the plan. Asserts the server end of what `enrichPatch` sends.
describe('applying a drafted detail back onto the task', () => {
  it('replaces the task’s sections without touching anything else', async () => {
    const task = await createTask('inbox writes are not crash-safe', 'thin');
    const { planId } = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/enrich`, {
        method: 'POST',
      })
    );
    const record = await waitForReadyPlan(planId);
    expect(record.proposal).toBeDefined();
    const drafted = record.proposal!.tasks[0];

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: drafted.description,
        acceptanceCriteria: drafted.acceptanceCriteria
          .map((c: string) => `- ${c}`)
          .join('\n'),
      }),
    });
    expect(res.status).toBe(200);

    const after = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(after.body).toContain(
      'packages/server/src/inbox.ts rewrites the whole file in place.'
    );
    expect(after.body).toContain(
      '- A crash mid-write leaves the inbox parseable'
    );
    expect(after.body).not.toContain('thin');
    // Deepening a task is not the same as re-titling or re-statusing it.
    expect(after.meta.title).toBe('inbox writes are not crash-safe');
    expect(after.meta.status).toBe(task.meta.status);
    // And it stays one task — the duplicate a confirm() would have created never appears.
    expect(await json(await fetch(`${baseUrl}/api/tasks`))).toHaveLength(1);
  });

  // Why enrichPatch omits an empty section instead of sending '': omitting is what preserves
  // a human's text.
  it('leaves a section alone when the patch omits it', async () => {
    const task = await createTask('inbox writes are not crash-safe');
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acceptanceCriteria: '- written by a human' }),
    });

    await fetch(`${baseUrl}/api/tasks/${task.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'drafted prose' }),
    });

    const after = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(after.body).toContain('drafted prose');
    expect(after.body).toContain('- written by a human');
  });
});
