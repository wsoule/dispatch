import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { hideArchivedRuns } from './archiveFilter';
import { countMergeReady } from './mergeReady';

// Builds a minimal RunMeta for these tests — only `taskId` varies per test,
// everything else is filler (mirrors mergeReady.test.ts's own `run` helper).
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

// Mirrors mergeReady.test.ts's own `makeTask` helper — `archivedAt` is the one field these
// cross-lib tests below actually vary.
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
      exercised: false,
      archivedAt,
    },
    body: '',
  };
}

describe('hideArchivedRuns', () => {
  test('drops runs whose taskId is archived, keeps others', () => {
    const runs = [
      run({ id: 'r1', taskId: 'archived-task' }),
      run({ id: 'r2', taskId: 'active-task' }),
    ];
    const result = hideArchivedRuns(runs, new Set(['archived-task']));
    expect(result).toEqual([run({ id: 'r2', taskId: 'active-task' })]);
  });

  test('returns the same array reference when the archived set is empty', () => {
    const runs = [run({ id: 'r1', taskId: 't1' })];
    expect(hideArchivedRuns(runs, new Set())).toBe(runs);
  });

  test('drops every run when every task is archived', () => {
    const runs = [
      run({ id: 'r1', taskId: 't1' }),
      run({ id: 'r2', taskId: 't2' }),
    ];
    expect(hideArchivedRuns(runs, new Set(['t1', 't2']))).toEqual([]);
  });
});

// `archivedAt` is orthogonal to a task's status — an archived task need not be done or
// cancelled (the server never guarantees the two happen together), so a finished, unreviewed
// run against an archived-but-still-in-review task must stay eligible for
// `countMergeReady`/enqueueReady even though the Runs view's own list hides it once its task
// is archived. These two libs are fed the exact same `runs`/`tasks` inputs here to pin that
// down: `useDispatchProject` MUST keep countMergeReady on the unfiltered `runs`, never
// `hideArchivedRuns`'s output, or a still-mergeable run would silently stop being offered the
// moment its task is archived (see Task 8's own countMergeReady fix for the sibling bug this
// would otherwise reintroduce).
describe('hideArchivedRuns vs countMergeReady — archived is not the same as done', () => {
  test('a run whose task is archived but still in-review is hidden from the list filter yet still counted as merge-ready', () => {
    const runs = [run({ id: 'r1', taskId: 'archived-in-review' })];
    const tasks = [
      makeTask(
        'archived-in-review',
        'in-review',
        [],
        '2026-01-03T00:00:00.000Z'
      ),
    ];
    const archivedIds = new Set(['archived-in-review']);

    expect(hideArchivedRuns(runs, archivedIds)).toEqual([]);
    expect(countMergeReady(runs, tasks, new Set())).toBe(1);
  });

  // A run archived on its own, with its task untouched — the case that lets you
  // clear finished work off the list without archiving a task you still want.
  test('hides a run archived on its own', () => {
    const runs = [
      run({ id: 'r-1', taskId: 't-1' }),
      run({ id: 'r-2', taskId: 't-1', archivedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    expect(hideArchivedRuns(runs, new Set()).map((r) => r.id)).toEqual(['r-1']);
  });

  test('keeps archived runs when nothing is archived at all', () => {
    const runs = [run({ id: 'r-1' }), run({ id: 'r-2' })];
    // Same reference back, so callers do not re-render on a no-op filter.
    expect(hideArchivedRuns(runs, new Set())).toBe(runs);
  });
});
