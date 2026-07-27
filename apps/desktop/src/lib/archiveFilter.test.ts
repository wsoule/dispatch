import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { hideArchivedRuns } from './archiveFilter';

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
