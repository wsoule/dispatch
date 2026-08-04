import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildReviewQueue } from './ReviewQueue';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

describe('buildReviewQueue', () => {
  test('queues a finished, unreviewed execute run', () => {
    expect(buildReviewQueue([run()])).toHaveLength(1);
  });

  test('drops a run a human has already reviewed', () => {
    const queue = buildReviewQueue([
      run({ reviewedAt: '2026-08-04T01:00:00.000Z' }),
    ]);
    expect(queue).toHaveLength(0);
  });

  // A review agent's own run is finished and never gets `reviewedAt` — nothing
  // reviews a reviewer — so it sat in the queue forever, under the same task
  // title as the run it had just reviewed.
  test('never queues the review agent that reviewed the work', () => {
    const queue = buildReviewQueue([
      run({ id: 'r-exec' }),
      run({
        id: 'r-rev',
        kind: 'review',
        branch: 'dispatch/review-t-1',
        baseBranch: 'dispatch/t-1',
      }),
    ]);
    expect(queue.map((i) => i.run.id)).toEqual(['r-exec']);
  });

  test('never queues a verify agent either', () => {
    const queue = buildReviewQueue([run({ id: 'r-ver', kind: 'verify' })]);
    expect(queue).toHaveLength(0);
  });

  // Absent `kind` predates the field and always meant an execute run, so an
  // older run must not be filtered out of the queue by this.
  test('treats a run with no kind as an execute run', () => {
    expect(buildReviewQueue([run({ kind: undefined })])).toHaveLength(1);
  });

  test('keeps an open PR even once it has been reviewed locally', () => {
    const queue = buildReviewQueue([
      run({ prUrl: 'https://github.com/x/y/pull/1', state: 'running' }),
    ]);
    expect(queue[0]?.isPr).toBe(true);
  });

  test('drops archived runs and sorts the rest newest first', () => {
    const queue = buildReviewQueue([
      run({ id: 'r-old', updatedAt: '2026-08-01T00:00:00.000Z' }),
      run({ id: 'r-arch', archivedAt: '2026-08-04T00:00:00.000Z' }),
      run({ id: 'r-new', updatedAt: '2026-08-03T00:00:00.000Z' }),
    ]);
    expect(queue.map((i) => i.run.id)).toEqual(['r-new', 'r-old']);
  });
});
