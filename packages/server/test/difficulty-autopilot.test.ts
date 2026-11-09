import type {
  AddLedgerInput,
  DifficultyJudgment,
  TaskDoc,
  TaskMeta,
} from '@dispatch-foo/core';
import { defaultTaskFields } from '@dispatch-foo/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DifficultyAutopilot } from '../src/difficultyAutopilot.js';
import { EventBus } from '../src/events.js';
import type { RunMeta, RunState } from '../src/orchestrator/types.js';
import { OrchestratorConflictError } from '../src/orchestrator/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ON = 'policy:\n  difficulty:\n    autoDispatch: true\n';

function task(id: string, over: Partial<TaskMeta> = {}): TaskDoc {
  return {
    meta: {
      id,
      title: `Task ${id}`,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      model: null,
      selfReview: true,
      writes: [`src/${id}.ts`],
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
      ...over,
    },
    body: 'Do the thing.\n',
  };
}

function run(taskId: string, state: RunState): RunMeta {
  return {
    id: `r-${taskId}`,
    taskId,
    taskTitle: taskId,
    executor: 'fake',
    state,
    branch: `dispatch/${taskId}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${taskId}`,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
  };
}

// The autopilot over a real temp config.yml and in-memory everything else.
// `judgments` answers per task id; an id absent from it is judged trivial.
function harness(opts: {
  config: string;
  tasks: TaskDoc[];
  judgments?: Record<string, DifficultyJudgment | null>;
  runs?: RunMeta[];
  milestoneScope?: string[];
  dispatchThrows?: Error;
}) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-autopilot-'));
  roots.push(root);
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'config.yml'), opts.config);
  const runs = opts.runs ?? [];
  const dispatched: { taskId: string; guard: string | null }[] = [];
  const judged: string[] = [];
  const ledger: AddLedgerInput[] = [];
  const activity: { taskId: string; text: string }[] = [];
  const autopilot = new DifficultyAutopilot({
    rootDir: root,
    tasks: () => opts.tasks,
    orchestrator: {
      list: () => runs,
      liveClaims: () =>
        runs
          .filter((r) => r.state === 'running')
          .map((r) => ({ claims: [`src/${r.taskId}.ts`] })),
      onRunTerminal: () => () => {},
      dispatchOrResume: (taskId, request) => {
        if (opts.dispatchThrows !== undefined) {
          return Promise.reject(opts.dispatchThrows);
        }
        const current = opts.tasks.find((t) => t.meta.id === taskId);
        const refusal =
          current === undefined ? 'gone' : (request.guard?.(current) ?? null);
        dispatched.push({ taskId, guard: refusal });
        if (refusal !== null) {
          return Promise.reject(new OrchestratorConflictError(refusal));
        }
        runs.push(run(taskId, 'running'));
        return Promise.resolve({});
      },
    },
    events: new EventBus(),
    judge: (t) => {
      judged.push(t.meta.id);
      const answer = opts.judgments?.[t.meta.id];
      return Promise.resolve(
        answer === undefined ? { level: 'trivial', confidence: 0.9 } : answer
      );
    },
    humanRef: 'human:test',
    ledgerStore: { add: (input) => ledger.push(input) as never },
    appendActivity: (taskId, text) => activity.push({ taskId, text }),
    ...(opts.milestoneScope === undefined
      ? {}
      : { milestoneScope: () => new Set(opts.milestoneScope) }),
  });
  const started = () =>
    dispatched.filter((d) => d.guard === null).map((d) => d.taskId);
  return { autopilot, runs, dispatched, started, judged, ledger, activity };
}

describe('DifficultyAutopilot', () => {
  it('is off by default and judges nothing', async () => {
    const h = harness({ config: 'autoCommit: true\n', tasks: [task('t-1')] });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual([]);
    expect(h.judged).toEqual([]);
  });

  it('dispatches an easy ready task and records why, in the ledger and the task Activity', async () => {
    const h = harness({ config: ON, tasks: [task('t-1')] });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual(['t-1']);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].title).toBe('t-1 auto-dispatched as low difficulty');
    expect(h.ledger[0].detail).toContain(
      'judged trivial (0.90), within the small threshold'
    );
    expect(h.ledger[0].authoredBy).toBe('human:test');
    expect(h.activity[0]).toEqual({
      taskId: 't-1',
      text: expect.stringContaining('[policy] t-1 auto-dispatched'),
    });
  });

  it('caps its own live runs at maxConcurrent', async () => {
    const tasks = [task('t-1'), task('t-2'), task('t-3')];
    const h = harness({ config: ON, tasks });
    await h.autopilot.runOnce();
    expect(h.started()).toHaveLength(1);
    // Its run is still live, so the next pass starts nothing.
    await h.autopilot.runOnce();
    expect(h.started()).toHaveLength(1);

    const wide = harness({
      config: `${ON}    maxConcurrent: 2\n`,
      tasks: [task('t-1'), task('t-2'), task('t-3')],
    });
    await wide.autopilot.runOnce();
    expect(wide.started()).toHaveLength(2);
  });

  it('skips hard, unjudged and low-confidence work', async () => {
    const h = harness({
      config: `${ON}    maxConcurrent: 5\n`,
      tasks: [task('t-1'), task('t-2'), task('t-3'), task('t-4')],
      judgments: {
        't-1': { level: 'substantial', confidence: 0.9 },
        't-2': null,
        't-3': { level: 'small', confidence: 0.4 },
      },
    });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual(['t-4']);
  });

  it('never picks a labelled, risky, assigned, backlog, already-run, milestone-owned or claim-blocked task, nor judges them', async () => {
    const h = harness({
      config: `${ON}    maxConcurrent: 9\n`,
      tasks: [
        task('t-label', { labels: ['no-auto-land'] }),
        task('t-risk', { risk: 'elevated' }),
        task('t-mate', { assignee: 'human:someone-else' }),
        task('t-backlog', { status: 'backlog' }),
        task('t-ran'),
        task('t-milestone'),
        task('t-clash', { writes: ['src/t-live.ts'] }),
        task('t-live', { status: 'in-progress' }),
        task('t-ok'),
      ],
      runs: [run('t-ran', 'failed'), run('t-live', 'running')],
      milestoneScope: ['t-milestone'],
    });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual(['t-ok']);
    expect(h.judged).toEqual(['t-ok']);
  });

  it('dispatches the human’s own task', async () => {
    const h = harness({
      config: ON,
      tasks: [task('t-1', { assignee: 'human:test' })],
    });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual(['t-1']);
  });

  it('records nothing when the dispatch is refused', async () => {
    const h = harness({
      config: ON,
      tasks: [task('t-1')],
      dispatchThrows: new OrchestratorConflictError('already running'),
    });
    await h.autopilot.runOnce();
    expect(h.ledger).toEqual([]);
    expect(h.activity).toEqual([]);
  });

  it('dispatches nothing on a config that does not parse', async () => {
    const h = harness({
      config: 'policy:\n  difficulty:\n    autoDispatch: maybe\n',
      tasks: [task('t-1')],
    });
    await h.autopilot.runOnce();
    expect(h.started()).toEqual([]);
  });
});
