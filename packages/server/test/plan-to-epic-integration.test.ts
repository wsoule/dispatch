import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { EpicEngine } from '../src/orchestrator/epic.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { PlanManager } from '../src/orchestrator/plan.js';
import type { PlanProposal } from '../src/orchestrator/planner.js';
import { FakePlanner } from '../src/orchestrator/planners/fake.js';
import { TERMINAL_RUN_STATES } from '../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './orchestrator/helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-plan-to-epic-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONCURRENCY = 2;
const CHILD_COUNT = 5;

// A five-task, no-epic-dependency proposal — every task is immediately
// ready, which is exactly the "5 ready children, concurrency 2" shape the
// plan's verification contract asks this integration proof to exercise.
const PROPOSAL: PlanProposal = {
  epic: {
    title: 'Ship the parallel epic',
    description: 'End-to-end plan -> confirm -> epic dispatch proof.',
  },
  tasks: Array.from({ length: CHILD_COUNT }, (_, i) => ({
    title: `Parallel child ${i}`,
    description: `Do part ${i} of the work.`,
    acceptanceCriteria: [`Part ${i} is done`],
    blockedByIndices: [],
    priority: 'medium' as const,
  })),
};

describe('plan -> confirm -> startEpic integration', () => {
  it('writes+commits a distinct file per child, never exceeds concurrency, and lands every child in-review with a real commit on its branch', async () => {
    const store = TaskStore.init(repo);
    const cache = new TaskCache();
    cache.rebuild(store);
    const events = new EventBus();
    const orchestrator = new Orchestrator({
      rootDir: repo,
      store,
      cache,
      events,
    });

    // Every dispatched run writes+commits one file into its OWN worktree
    // (cwd) before pausing at an approval gate — the pause is what gives
    // this test an observable "live" window to sample concurrency against
    // (see epic.test.ts's own use of the same technique); the write+commit
    // happening *before* that pause is what proves each child produces a
    // real, distinct commit on its own branch, not just a log entry.
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              // `basename(cwd)` is the run's own id (worktreePath's last
              // segment) — a stable, run-unique value available at write
              // time with nothing extra threaded through FakeExecutor's
              // script, so distinct children genuinely get distinct files.
              writeFileSync(
                join(cwd, `output-${basename(cwd)}.txt`),
                `work done by run ${basename(cwd)}\n`
              );
            },
            commitMessage: 'fake executor: child work',
          },
          { approval: { requestId: 'go', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'finished', costUsd: 0.01, turns: 2 },
      })
    );

    const planManager = new PlanManager(
      { store, cache, events },
      new FakePlanner({ ok: true, proposal: PROPOSAL })
    );
    const epicEngine = new EpicEngine({
      rootDir: repo,
      store,
      cache,
      events,
      orchestrator,
    });

    // --- plan -------------------------------------------------------
    const plan = planManager.startPlan('build 5 parallel things');
    await waitFor(() => planManager.get(plan.id).state === 'ready');
    expect(planManager.get(plan.id).proposal).toEqual(PROPOSAL);

    // --- confirm ------------------------------------------------------
    const { epicId, taskIds } = planManager.confirm(plan.id, PROPOSAL);
    expect(taskIds).toHaveLength(CHILD_COUNT);
    const childSet = new Set(taskIds);

    // --- startEpic + concurrency-sampled dispatch ----------------------
    const session = epicEngine.start(epicId!, {
      concurrency: CONCURRENCY,
      executor: 'fake',
    });
    expect(session.concurrency).toBe(CONCURRENCY);

    // Registry-sampling instrumentation: poll orchestrator.list() on a
    // tight interval for the whole run and record the max number of this
    // epic's children ever observed simultaneously live — this is the
    // actual concurrency guarantee under test, not just an assumption
    // from reading fillQueue's code.
    let maxObservedLive = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const live = orchestrator
          .list()
          .filter(
            (r) => childSet.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
          ).length;
        maxObservedLive = Math.max(maxObservedLive, live);
        await sleep(3);
      }
    })();

    let finished = 0;
    while (finished < CHILD_COUNT) {
      const awaiting = orchestrator
        .list()
        .filter(
          (r) => childSet.has(r.taskId) && r.state === 'awaiting-approval'
        );
      if (awaiting.length === 0) {
        await sleep(10);
        continue;
      }
      orchestrator.approve(awaiting[0].id, 'go', true);
      finished++;
      await sleep(15);
    }

    await waitFor(() =>
      taskIds.every((id) => store.get(id)?.meta.status === 'in-review')
    );
    sampling = false;
    await sampler;

    // --- assertions -----------------------------------------------------
    expect(maxObservedLive).toBeGreaterThan(0);
    expect(maxObservedLive).toBeLessThanOrEqual(CONCURRENCY);

    for (const taskId of taskIds) {
      const task = store.get(taskId);
      expect(task?.meta.status).toBe('in-review');
      expect(task?.meta.parent).toBe(epicId);
    }

    // Every child's run really did commit a distinct file on its own
    // branch — verified against real git, not just the FakeExecutor's
    // log entries.
    const runs = orchestrator.list().filter((r) => childSet.has(r.taskId));
    expect(runs).toHaveLength(CHILD_COUNT);
    const seenFiles = new Set<string>();
    for (const run of runs) {
      const log = runGitSync(repo, [
        'log',
        `${run.baseBranch}..${run.branch}`,
        '--name-only',
        '--pretty=format:',
      ]).trim();
      const files = log.split('\n').filter((f) => f.trim() !== '');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^output-r-[0-9a-f]{6}\.txt$/);
      seenFiles.add(files[0]);
    }
    // Every run's committed file is unique across the whole epic.
    expect(seenFiles.size).toBe(CHILD_COUNT);

    const epicDoc = store.get(epicId!);
    expect(epicDoc?.body).toContain('epic dispatch started');
  }, 15000);
});
