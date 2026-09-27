import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { deriveTaskAttentionById } from './taskAttention';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function derive(
  runs: RunMeta[],
  askingTaskIds: ReadonlySet<string> = new Set(),
  mergeQueue: MergeQueueSnapshot | null = null
) {
  const latestRunByTaskId = new Map(runs.map((r) => [r.taskId, r]));
  return deriveTaskAttentionById(latestRunByTaskId, askingTaskIds, mergeQueue);
}

describe('deriveTaskAttentionById', () => {
  test('a run awaiting approval marks its task as waiting', () => {
    const map = derive([run({ state: 'awaiting-approval' })]);
    expect(map.get('t-1')).toBe('waiting');
  });

  test('a running run with an open question marks its task as waiting', () => {
    const map = derive([run()], new Set(['t-1']));
    expect(map.get('t-1')).toBe('waiting');
  });

  // An ended run's question stays open for its task, which still owes an answer.
  test('an ended run with an open ask still marks its task as waiting', () => {
    expect(
      derive([run({ state: 'finished' })], new Set(['t-1'])).get('t-1')
    ).toBe('waiting');
    expect(
      derive(
        [run({ state: 'finished', reviewedAt: '2026-07-27T00:00:00.000Z' })],
        new Set(['t-1'])
      ).get('t-1')
    ).toBe('waiting');
  });

  test('a running run with no questions needs no attention', () => {
    expect(derive([run()]).has('t-1')).toBe(false);
  });

  test('a dead run (failed, no session) marks its task as failed', () => {
    const map = derive([run({ state: 'failed' })]);
    expect(map.get('t-1')).toBe('failed');
  });

  test('a finished, unreviewed run marks its task as needing review', () => {
    const map = derive([run({ state: 'finished' })]);
    expect(map.get('t-1')).toBe('review');
  });

  test('a reviewed run needs nothing — the task drops out entirely', () => {
    const map = derive([
      run({ state: 'finished', reviewedAt: '2026-07-27T00:00:00.000Z' }),
    ]);
    expect(map.has('t-1')).toBe(false);
  });

  test('a run landing through the merge queue is not "needs review"', () => {
    const queue = {
      entries: [{ runId: 'r-1', state: 'merging' }],
    } as MergeQueueSnapshot;
    const map = derive([run({ state: 'finished' })], new Set(), queue);
    expect(map.has('t-1')).toBe(false);
  });

  test('a run whose merge-queue entry failed marks its task as failed', () => {
    const queue = {
      entries: [{ runId: 'r-1', state: 'failed' }],
    } as MergeQueueSnapshot;
    const map = derive([run({ state: 'finished' })], new Set(), queue);
    expect(map.get('t-1')).toBe('failed');
  });
});
