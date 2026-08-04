import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type {
  Planner,
  PlannerTurn,
  PlanProposal,
} from '../src/orchestrator/planner.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth, wsUrl } from './testAuth.js';

function json(res: Response): Promise<any> {
  return res.json();
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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-plan-epic-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function fakeApprovalExecutor(): FakeExecutor {
  return new FakeExecutor({
    steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
}

const SAMPLE_PROPOSAL: PlanProposal = {
  epic: { title: 'Ship the widget', description: 'Build the whole widget.' },
  tasks: [
    {
      title: 'Design',
      description: 'Sketch it.',
      acceptanceCriteria: ['Sketch reviewed'],
      blockedByIndices: [],
      priority: 'high',
    },
    {
      title: 'Implement',
      description: 'Build it.',
      acceptanceCriteria: ['Tests pass'],
      blockedByIndices: [0],
      priority: 'medium',
    },
  ],
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
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function startWithPlanner(planner: FakePlanner): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerPlanners: (planManager) => {
      planManager.registerPlanner('claude', planner);
    },
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('fake', fakeApprovalExecutor());
      orchestrator.registerExecutor('claude', fakeApprovalExecutor());
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

describe('POST /api/plan and GET /api/plan/:id', () => {
  it('goes 202 running -> ready and returns the proposal', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );

    const startRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'build a widget' }),
    });
    expect(startRes.status).toBe(202);
    const { planId } = await json(startRes);
    expect(typeof planId).toBe('string');

    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
      return r.state !== 'running';
    });
    const record = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
  });

  it('400s an empty prompt', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown plan id', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/plan/plan-000000`);
    expect(res.status).toBe(404);
  });

  it('broadcasts plan.changed over the websocket', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const ws = new WebSocket(wsUrl(handle));
    const gotPlanChanged = new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as { type: string };
        if (parsed.type === 'plan.changed') resolve();
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve())
    );

    await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'build a widget' }),
    });
    await Promise.race([
      gotPlanChanged,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WS timeout')), 3000)
      ),
    ]);
    ws.close();
  });
});

describe('POST /api/tasks/draft and GET/DELETE /api/tasks/drafts', () => {
  async function draftedTask(): Promise<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: string;
  }> {
    const started = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'please design the widget' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
      );
      return r.state !== 'running';
    });
    const record = await json(
      await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
    );
    return record.proposal.tasks[0];
  }

  it('202s immediately with state running, then GET settles ready with the proposal', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const startRes = await fetch(`${baseUrl}/api/tasks/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'please design the widget' }),
    });
    expect(startRes.status).toBe(202);
    const started = await json(startRes);
    expect(started.state).toBe('running');
    expect(typeof started.id).toBe('string');

    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
      );
      return r.state !== 'running';
    });
    const record = await json(
      await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
    );
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
  });

  it('400s an empty prompt', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/tasks/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('lands a failing draft as failed with error set, without touching a concurrent successful draft', async () => {
    // Two independently-registered planners: 'claude' succeeds, 'broken' errors.
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerPlanners: (planManager) => {
        planManager.registerPlanner(
          'claude',
          new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
        );
        planManager.registerPlanner(
          'broken',
          new FakePlanner({ ok: false, error: 'planner exploded' })
        );
      },
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('fake', fakeApprovalExecutor());
        orchestrator.registerExecutor('claude', fakeApprovalExecutor());
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const good = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'please design the widget' }),
      })
    );
    const bad = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'anything', planner: 'broken' }),
      })
    );

    await waitFor(async () => {
      const g = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${good.id}`)
      );
      const b = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${bad.id}`)
      );
      return g.state !== 'running' && b.state !== 'running';
    });

    const badRecord = await json(
      await fetch(`${baseUrl}/api/tasks/drafts/${bad.id}`)
    );
    expect(badRecord.state).toBe('failed');
    expect(badRecord.error).toBe('planner exploded');

    const goodRecord = await json(
      await fetch(`${baseUrl}/api/tasks/drafts/${good.id}`)
    );
    expect(goodRecord.state).toBe('ready');
    expect(goodRecord.proposal).toEqual(SAMPLE_PROPOSAL);
  });

  it('GET /api/tasks/drafts lists every draft, newest first', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const first = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'first' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${first.id}`)
      );
      return r.state !== 'running';
    });
    const second = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'second' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${second.id}`)
      );
      return r.state !== 'running';
    });

    const list = await json(await fetch(`${baseUrl}/api/tasks/drafts`));
    const ids = list.map((d: { id: string }) => d.id);
    expect(ids[0]).toBe(second.id);
    expect(ids).toContain(first.id);
  });

  it('404s GET /api/tasks/drafts/:id for an unknown id', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/tasks/drafts/d-000000`);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tasks/drafts/:id dismisses the draft (subsequent GET 404s), 404s an unknown id', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const started = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'please design the widget' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
      );
      return r.state !== 'running';
    });

    const delRes = await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`);
    expect(getRes.status).toBe(404);

    const unknownDelRes = await fetch(`${baseUrl}/api/tasks/drafts/d-000000`, {
      method: 'DELETE',
    });
    expect(unknownDelRes.status).toBe(404);
  });

  it('broadcasts draft.changed over the websocket', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const ws = new WebSocket(wsUrl(handle));
    const gotDraftChanged = new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as { type: string };
        if (parsed.type === 'draft.changed') resolve();
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve())
    );

    await fetch(`${baseUrl}/api/tasks/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'build a widget' }),
    });
    await Promise.race([
      gotDraftChanged,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WS timeout')), 3000)
      ),
    ]);
    ws.close();
  });

  // The load-bearing round trip: a drafted task saves through the SAME
  // POST /api/tasks (createTask) path a manual CreateTaskModal task uses, with
  // no schema change. createTask only renders the `description` section, so the
  // acceptanceCriteria list is folded into the description exactly as a
  // confirmed plan's tasks are (buildTaskDescription) — the same fold the
  // client's taskDraftToCreateInput performs.
  it('saves the drafted task through the normal createTask path', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const draft = await draftedTask();
    const description = [
      draft.description.trim(),
      'Acceptance criteria:',
      draft.acceptanceCriteria.map((c: string) => `- ${c}`).join('\n'),
    ].join('\n\n');
    const created = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          kind: 'task',
          priority: draft.priority,
          description,
        }),
      })
    );
    expect(created.meta.kind).toBe('task');
    expect(created.meta.priority).toBe('high');
    expect(created.meta.title).toBe('Design');
    expect(created.body).toContain('Sketch it.');
    expect(created.body).toContain('Sketch reviewed');
  });
});

describe('POST /api/tasks/drafts/:id/message', () => {
  function questionThenAnswerPlanner(): FakePlanner {
    return new FakePlanner({
      ok: true,
      turns: [
        {
          reply: 'quick question first',
          proposal: null,
          questions: [{ id: 'q1', question: 'Scope?', options: [] }],
        },
        { reply: 'here you go', proposal: SAMPLE_PROPOSAL },
      ],
    });
  }

  async function startedDraftAwaitingAnswer(): Promise<string> {
    await startWithPlanner(questionThenAnswerPlanner());
    const started = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'please design something' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
      );
      return r.state !== 'running';
    });
    return started.id;
  }

  it('202s a follow-up, clears the questions, and settles ready with the proposal', async () => {
    const draftId = await startedDraftAwaitingAnswer();

    const res = await fetch(`${baseUrl}/api/tasks/drafts/${draftId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'desktop only' }),
    });
    expect(res.status).toBe(202);
    const accepted = await json(res);
    expect(accepted.state).toBe('running');
    expect(accepted.questions).toEqual([]);

    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${draftId}`)
      );
      return r.state !== 'running';
    });
    const record = await json(
      await fetch(`${baseUrl}/api/tasks/drafts/${draftId}`)
    );
    expect(record.state).toBe('ready');
    expect(record.proposal).toEqual(SAMPLE_PROPOSAL);
    expect(record.message).toBe('here you go');
  });

  it('400s an empty message text', async () => {
    const draftId = await startedDraftAwaitingAnswer();
    const res = await fetch(`${baseUrl}/api/tasks/drafts/${draftId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s a follow-up to an unknown draft', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/tasks/drafts/d-000000/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  // A FakePlanner script settles too fast to race an HTTP call against — this
  // stand-in never resolves `start`, so the draft sits `running` for the test.
  it('409s a follow-up while a turn is still running', async () => {
    const neverSettles: Planner = {
      start: () => new Promise<PlannerTurn>(() => {}),
      sendMessage: () => new Promise<PlannerTurn>(() => {}),
    };
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerPlanners: (planManager) => {
        planManager.registerPlanner('claude', neverSettles);
      },
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', fakeApprovalExecutor());
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const started = await json(
      await fetch(`${baseUrl}/api/tasks/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'please design something' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${baseUrl}/api/tasks/drafts/${started.id}`)
      );
      return r.state === 'running';
    });

    const res = await fetch(
      `${baseUrl}/api/tasks/drafts/${started.id}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'too soon' }),
      }
    );
    expect(res.status).toBe(409);
  });
});

describe('POST /api/plan/:id/confirm', () => {
  async function startedPlanId(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'build a widget' }),
    });
    return (await json(res)).planId;
  }

  it('writes the epic + tasks and returns their ids', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const planId = await startedPlanId();

    const res = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: SAMPLE_PROPOSAL }),
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.epicId).toBeDefined();
    expect(result.taskIds).toHaveLength(2);

    const epic = await json(
      await fetch(`${baseUrl}/api/tasks/${result.epicId}`)
    );
    expect(epic.meta.kind).toBe('epic');
    expect(epic.meta.status).toBe('todo');
  });

  it('404s confirming an unknown plan', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/plan/plan-000000/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: SAMPLE_PROPOSAL }),
    });
    expect(res.status).toBe(404);
  });

  it('409s a second confirm of the same plan', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const planId = await startedPlanId();
    await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: SAMPLE_PROPOSAL }),
    });
    const res = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: SAMPLE_PROPOSAL }),
    });
    expect(res.status).toBe(409);
  });

  it('400s a proposal with an invalid shape', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const planId = await startedPlanId();
    const res = await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: { tasks: 'nope' } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/plan/:id/message', () => {
  const DRAFT_ONE: PlanProposal = {
    tasks: [
      {
        title: 'Only task',
        description: 'The opening draft.',
        acceptanceCriteria: [],
        blockedByIndices: [],
        priority: 'medium',
      },
    ],
  };
  const DRAFT_TWO: PlanProposal = {
    tasks: [
      {
        title: 'Only task',
        description: 'The opening draft.',
        acceptanceCriteria: [],
        blockedByIndices: [],
        priority: 'medium',
      },
      {
        title: 'Added task',
        description: 'Requested on the follow-up.',
        acceptanceCriteria: [],
        blockedByIndices: [0],
        priority: 'low',
      },
    ],
  };

  async function startedConversationPlanId(): Promise<string> {
    await startWithPlanner(
      new FakePlanner({
        ok: true,
        turns: [
          { reply: 'first draft', proposal: DRAFT_ONE },
          { reply: 'added the task', proposal: DRAFT_TWO },
        ],
      })
    );
    const { planId } = await json(
      await fetch(`${baseUrl}/api/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'build a widget' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
      return r.state === 'ready';
    });
    return planId;
  }

  it('202s a follow-up and refines the working proposal + grows the transcript', async () => {
    const planId = await startedConversationPlanId();

    const res = await fetch(`${baseUrl}/api/plan/${planId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'add a second task' }),
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
      return r.state === 'ready' && r.proposal?.tasks.length === 2;
    });
    const record = await json(await fetch(`${baseUrl}/api/plan/${planId}`));
    expect(record.proposal).toEqual(DRAFT_TWO);
    expect(record.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('400s an empty message text', async () => {
    const planId = await startedConversationPlanId();
    const res = await fetch(`${baseUrl}/api/plan/${planId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s a follow-up to an unknown plan', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/plan/plan-000000/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s a message to an already-confirmed plan', async () => {
    const planId = await startedConversationPlanId();
    await fetch(`${baseUrl}/api/plan/${planId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: DRAFT_ONE }),
    });
    const res = await fetch(`${baseUrl}/api/plan/${planId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'one more change' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/epics/:id/dispatch, /stop, GET /progress', () => {
  async function createEpicWithChildren(count: number): Promise<{
    epicId: string;
    childIds: string[];
  }> {
    const epicRes = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Test epic', kind: 'epic' }),
      })
    );
    const childIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const child = await json(
        await fetch(`${baseUrl}/api/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: `Child ${i}`,
            kind: 'task',
            parent: epicRes.meta.id,
            writes: [`child-${i}.ts`],
          }),
        })
      );
      childIds.push(child.meta.id);
    }
    return { epicId: epicRes.meta.id, childIds };
  }

  it('dispatches ready children up to the concurrency cap using the executor override', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const { epicId } = await createEpicWithChildren(3);

    const res = await fetch(`${baseUrl}/api/epics/${epicId}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 2, executor: 'fake' }),
    });
    expect(res.status).toBe(201);
    const session = await json(res);
    expect(session.concurrency).toBe(2);
    expect(session.active).toBe(true);

    await waitFor(async () => {
      const progress = await json(
        await fetch(`${baseUrl}/api/epics/${epicId}/progress`)
      );
      return progress.liveRuns.length === 2;
    });
  });

  it('404s dispatching an unknown epic', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/epics/e-000000/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('stops new dispatches while a live run continues', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const { epicId } = await createEpicWithChildren(2);

    await fetch(`${baseUrl}/api/epics/${epicId}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 1, executor: 'fake' }),
    });
    await waitFor(async () => {
      const progress = await json(
        await fetch(`${baseUrl}/api/epics/${epicId}/progress`)
      );
      return progress.liveRuns.length === 1;
    });

    const stopRes = await fetch(`${baseUrl}/api/epics/${epicId}/stop`, {
      method: 'POST',
    });
    expect(stopRes.status).toBe(200);
    expect((await json(stopRes)).active).toBe(false);
  });

  it('409s stopping an epic with no active session', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const { epicId } = await createEpicWithChildren(1);
    const res = await fetch(`${baseUrl}/api/epics/${epicId}/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/runs/:id/inject', () => {
  it('400s empty text', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Inject me' }),
      })
    );
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown run id', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/runs/r-000000/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s a run that is not running (still awaiting-approval)', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Awaiting approval' }),
      })
    );
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'awaiting-approval';
    });
    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
  });

  it('200s and prefixes the message for a live running run', async () => {
    // A FakeExecutor script always either pauses at an approval gate or
    // finishes almost immediately — neither leaves a `running` window wide
    // enough to reliably race an HTTP call against. This dedicated Executor
    // never calls onFinish/onApprovalRequest on its own, so the run sits in
    // `running` until the test explicitly resolves it — a controllable stand-
    // in purpose-built for exercising the `running`-only inject() gate over
    // the real HTTP surface.
    const sent: string[] = [];
    // Deliberately never calls `events.onFinish`/`onApprovalRequest` — the
    // run just sits in `running` until the test itself decides it's done
    // observing.
    const controllable: Executor = {
      start(_opts, _events) {
        return {
          interrupt: async () => {},
          requestStop: () => {},
          send: (message: string) => sent.push(message),
          approve: () => {},
        } satisfies ExecutorRun;
      },
    };
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
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', controllable);
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Long running' }),
      })
    );
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'claude' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'running';
    });

    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from another agent' }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => Promise.resolve(sent.length === 1));
    expect(sent[0]).toBe(
      '[message from another agent] hello from another agent'
    );
  });

  // agent-comms: `fromRunId` is how the MCP `agent_message` tool identifies
  // its own run as the sender (via DISPATCH_RUN_ID — see packages/mcp/src/
  // tools.ts) — resolving it against a real second run proves the API route
  // actually threads the value through to Orchestrator.inject rather than
  // dropping it, landing a real task-title label in both the delivered
  // prefix and the recorded message entry instead of the generic fallback.
  it("resolves fromRunId to the sender run's task title + id label", async () => {
    const sent: string[] = [];
    const controllable: Executor = {
      start(_opts, _events) {
        return {
          interrupt: async () => {},
          requestStop: () => {},
          send: (message: string) => sent.push(message),
          approve: () => {},
        } satisfies ExecutorRun;
      },
    };
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

    const senderTask = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Sender task' }),
      })
    );
    const senderMeta = await json(
      await fetch(`${baseUrl}/api/tasks/${senderTask.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'claude' }),
      })
    );

    const targetTask = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Target task' }),
      })
    );
    const targetMeta = await json(
      await fetch(`${baseUrl}/api/tasks/${targetTask.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'claude' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${targetMeta.id}`));
      return r.meta.state === 'running';
    });

    const res = await fetch(`${baseUrl}/api/runs/${targetMeta.id}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'need a hand',
        fromRunId: senderMeta.id,
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => Promise.resolve(sent.length === 1));
    expect(sent[0]).toBe(
      `[message from Sender task (${senderMeta.id})] need a hand`
    );

    const detail = await json(
      await fetch(`${baseUrl}/api/runs/${targetMeta.id}`)
    );
    const messageEntry = detail.entries.find(
      (e: { kind: string }) => e.kind === 'message'
    );
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'agent',
      fromLabel: `Sender task (${senderMeta.id})`,
      text: 'need a hand',
    });
  });
});

describe('POST /api/runs/:id/message-user', () => {
  it('400s a missing text field', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Message user body validation' }),
      })
    );
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/message-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown run id', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const res = await fetch(`${baseUrl}/api/runs/r-000000/message-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  // Records a `from: 'agent'` entry on the CALLING run's own transcript,
  // labeled with that run's own task title + id — the agent->human channel
  // (spec's `message_user`) — and broadcasts it exactly like `inject` does,
  // so a connected Session tab sees it without a manual refetch.
  it("200s and records a from:agent entry labeled with the run's own task", async () => {
    const controllable: Executor = {
      start(_opts, _events) {
        return {
          interrupt: async () => {},
          requestStop: () => {},
          send: () => {},
          approve: () => {},
        } satisfies ExecutorRun;
      },
    };
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

    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Flag something' }),
      })
    );
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'claude' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'running';
    });

    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/message-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'need clarification on X' }),
    });
    expect(res.status).toBe(200);

    const detail = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
    const messageEntry = detail.entries.find(
      (e: { kind: string }) => e.kind === 'message'
    );
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'agent',
      fromLabel: `Flag something (${meta.id})`,
      text: 'need clarification on X',
    });
  });
});

describe('GET /api/health pr capability', () => {
  it('reports pr: false when there is no configured git remote', async () => {
    await startWithPlanner(
      new FakePlanner({ ok: true, proposal: SAMPLE_PROPOSAL })
    );
    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.pr).toBe(false);
  });

  it('reports pr: true when the injected command runner reports both capabilities', async () => {
    const stubRunner = async (
      _cwd: string,
      cmd: string[]
    ): Promise<CommandResult> => ({
      ok: true,
      stdout: cmd[0] === 'gh' ? 'gh version 2.0.0' : 'origin-url',
      stderr: '',
    });
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
      prCommandRunner: stubRunner,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('fake', fakeApprovalExecutor());
        orchestrator.registerExecutor('claude', fakeApprovalExecutor());
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.pr).toBe(true);
  });
});
