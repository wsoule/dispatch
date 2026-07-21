import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { PlanProposal } from '../src/orchestrator/planner.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';

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
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
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
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.pr).toBe(true);
  });
});
