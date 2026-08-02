import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { countMergeReady } from './mergeReady';

// Builds a minimal RunMeta for these tests — only the eligibility-relevant
// fields need to vary per test, everything else is filler.
function run(overrides: Partial<RunMeta>): RunMeta {
  return {
    id: 'run-1',
    taskId: 't-1',
    taskTitle: 'Task',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(
  id: string,
  status: string,
  blockedBy: string[] = [],
  archivedAt?: string
): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status,
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy,
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      archivedAt,
    },
    body: '',
  };
}

describe('countMergeReady', () => {
  test('a finished, unreviewed run with no blockers counts', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [makeTask('t1', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(1);
  });

  test('an already-reviewed run does not count', () => {
    const runs = [
      run({ id: 'r1', taskId: 't1', reviewedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const tasks = [makeTask('t1', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  test('a run with an open PR does not count — review moved to GitHub', () => {
    const runs = [
      run({ id: 'r1', taskId: 't1', prUrl: 'https://example.com/pr/1' }),
    ];
    const tasks = [makeTask('t1', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  test('a run whose task is blocked by an undone task does not count', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [
      makeTask('blocker', 'todo'),
      makeTask('t1', 'in-review', ['blocker']),
    ];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  test('a run whose task is blocked only by done/cancelled tasks counts', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [
      makeTask('done-blocker', 'done'),
      makeTask('cancelled-blocker', 'cancelled'),
      makeTask('t1', 'in-review', ['done-blocker', 'cancelled-blocker']),
    ];
    expect(countMergeReady(runs, tasks, new Set())).toBe(1);
  });

  test('a run already sitting in the merge queue does not count again', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [makeTask('t1', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set(['r1']))).toBe(0);
  });

  test('a run whose own task is already cancelled does not count', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [makeTask('t1', 'cancelled')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  // `tasks` must be the archived-inclusive list (fetchTasks({ archived: true }))
  // — the default board-view fetch excludes archived tasks entirely, which
  // would make an archived own-task/blocker missing from `byId` rather than
  // correctly read as done. These two cases only pass when an archived task
  // is actually present in the array.
  test('an archived, done own task does not count, even though it is archived', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [makeTask('t1', 'done', [], '2026-01-03T00:00:00.000Z')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  test('an archived, done blocker still satisfies the blockedBy gate', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    const tasks = [
      makeTask('archived-blocker', 'done', [], '2026-01-03T00:00:00.000Z'),
      makeTask('t1', 'in-review', ['archived-blocker']),
    ];
    expect(countMergeReady(runs, tasks, new Set())).toBe(1);
  });

  test('a still-running or non-finished-terminal run does not count', () => {
    const runs = [run({ id: 'r1', taskId: 't1', state: 'failed' })];
    const tasks = [makeTask('t1', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(0);
  });

  test('multiple eligible runs across tasks all count', () => {
    const runs = [
      run({ id: 'r1', taskId: 't1' }),
      run({ id: 'r2', taskId: 't2' }),
    ];
    const tasks = [makeTask('t1', 'in-review'), makeTask('t2', 'in-review')];
    expect(countMergeReady(runs, tasks, new Set())).toBe(2);
  });
});
