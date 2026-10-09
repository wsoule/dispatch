import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { taskOutcome } from './taskOutcome';

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

const open = { completed: false, canceled: false };

describe('taskOutcome', () => {
  test('nothing run yet, or a run still going, has no outcome', () => {
    expect(taskOutcome({ ...open, runs: [] })).toBeNull();
    expect(
      taskOutcome({ ...open, runs: [run({ state: 'running' })] })
    ).toBeNull();
  });

  test('a canceled task was dropped, whatever its runs did', () => {
    expect(
      taskOutcome({ completed: false, canceled: true, runs: [run({})] })
    ).toEqual({
      kind: 'dropped',
    });
  });

  test('a merge on origin, or in a base with no remote, landed', () => {
    const origin = run({
      reviewAction: 'merge',
      mergeCommit: 'abc',
      pushedToOrigin: true,
      reviewedAt: 'x',
    });
    expect(taskOutcome({ ...open, runs: [origin] })).toMatchObject({
      kind: 'landed',
      where: 'origin',
    });
    const local = run({
      reviewAction: 'merge',
      mergeCommit: 'abc',
      landsOn: 'local',
      reviewedAt: 'x',
    });
    expect(taskOutcome({ ...open, runs: [local] })).toMatchObject({
      kind: 'landed',
      where: 'local',
    });
  });

  test('a merge that never reached origin is not called landed', () => {
    const r = run({
      reviewAction: 'merge',
      mergeCommit: 'abc',
      reviewedAt: 'x',
    });
    expect(taskOutcome({ ...open, runs: [r] })).toMatchObject({
      kind: 'merged-local',
    });
  });

  test('an open PR waits on GitHub', () => {
    const r = run({ prUrl: 'https://github.com/o/r/pull/12' });
    expect(taskOutcome({ ...open, runs: [r] })).toMatchObject({
      kind: 'pr-open',
    });
  });

  test('a completed task with no recorded merge landed outside the queue, keeping its run', () => {
    const r = run({ reviewAction: 'merge', reviewedAt: 'x', costUsd: 1.5 });
    expect(
      taskOutcome({ completed: true, canceled: false, runs: [r] })
    ).toEqual({
      kind: 'landed',
      where: 'outside',
      run: r,
    });
    expect(taskOutcome({ completed: true, canceled: false, runs: [] })).toEqual(
      {
        kind: 'landed',
        where: 'outside',
        run: undefined,
      }
    );
  });

  test('a failed landing says why, before anything else about the run', () => {
    const r = run({
      reviewFailure: { action: 'merge', reason: 'conflict in a.ts', at: 'x' },
    });
    expect(taskOutcome({ ...open, runs: [r] })).toMatchObject({
      kind: 'land-failed',
      reason: 'conflict in a.ts',
    });
  });

  test('the newest run decides between failed and ready', () => {
    const failed = run({
      id: 'r-old',
      state: 'failed',
      error: 'boom',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const ready = run({
      id: 'r-new',
      state: 'finished',
      createdAt: '2026-01-02T00:00:00Z',
    });
    expect(taskOutcome({ ...open, runs: [failed, ready] })).toMatchObject({
      kind: 'ready',
      run: { id: 'r-new' },
    });
    expect(
      taskOutcome({ ...open, runs: [ready, failed].slice(1) })
    ).toMatchObject({
      kind: 'run-failed',
      reason: 'boom',
    });
  });
});
