import type { BranchEntry, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  buildLandedBuckets,
  isStaleBranch,
  landedBucketOf,
} from './landedBuckets';

function entry(overrides: Partial<BranchEntry>): BranchEntry {
  return {
    branch: 'dispatch/t-x-r1',
    worktreeExists: false,
    dirty: false,
    ahead: 1,
    mergedIntoBase: false,
    pushedToOrigin: false,
    status: 'reviewable',
    ...overrides,
  };
}

function run(overrides: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-x',
    taskTitle: 'Some task',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-x-r1',
    baseBranch: 'main',
    worktreePath: '',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  } as RunMeta;
}

function mergedRun(overrides: Partial<RunMeta>): RunMeta {
  return run({
    reviewedAt: '2026-08-10T12:00:00.000Z',
    reviewAction: 'merge',
    mergeCommit: 'abc123',
    ...overrides,
  });
}

describe('landedBucketOf', () => {
  test('merged and pushed lands in merged-pushed', () => {
    expect(
      landedBucketOf(entry({ mergedIntoBase: true, pushedToOrigin: true }))
    ).toBe('merged-pushed');
  });

  test('merged but not on origin is merged-local — the not-yet-shared state', () => {
    expect(
      landedBucketOf(entry({ mergedIntoBase: true, pushedToOrigin: false }))
    ).toBe('merged-local');
  });

  test('merged wins over registry status: a merged leftover/orphan is still landed', () => {
    for (const status of ['leftover', 'orphan'] as const) {
      expect(landedBucketOf(entry({ mergedIntoBase: true, status }))).toBe(
        'merged-local'
      );
    }
  });

  test('an unmerged live run is in-progress', () => {
    expect(landedBucketOf(entry({ status: 'active' }))).toBe('in-progress');
  });

  test('an unmerged terminal run nobody reviewed is awaiting-review', () => {
    expect(landedBucketOf(entry({ status: 'reviewable' }))).toBe(
      'awaiting-review'
    );
  });

  test('unmerged refs nothing owns are abandoned', () => {
    for (const status of ['orphan', 'leftover'] as const) {
      expect(landedBucketOf(entry({ status }))).toBe('abandoned');
    }
  });
});

describe('buildLandedBuckets', () => {
  test('a merged run shows as landed even though review() deleted its ref', () => {
    const buckets = buildLandedBuckets(
      [],
      [mergedRun({ id: 'r-1', pushedToOrigin: true })]
    );
    expect(buckets['merged-pushed'].map((r) => r.key)).toEqual(['r-1']);
  });

  test('a locally-merged run whose merge has not reached origin is merged-local', () => {
    const buckets = buildLandedBuckets(
      [],
      [mergedRun({ pushedToOrigin: false })]
    );
    expect(buckets['merged-local']).toHaveLength(1);
    expect(buckets['merged-pushed']).toHaveLength(0);
  });

  test('a PR-merged run is pushed by definition, and a no-op merge has nothing to push', () => {
    const buckets = buildLandedBuckets(
      [],
      [
        mergedRun({ id: 'r-pr', reviewAction: 'pr', mergeCommit: undefined }),
        mergedRun({
          id: 'r-noop',
          branch: 'dispatch/t-y-r1',
          mergeCommit: undefined,
        }),
      ]
    );
    expect(buckets['merged-pushed'].map((r) => r.key).sort()).toEqual([
      'r-noop',
      'r-pr',
    ]);
  });

  test('discarded, unreviewed, and archived runs land nothing', () => {
    const buckets = buildLandedBuckets(
      [],
      [
        run({ id: 'r-d', reviewedAt: '2026-08-10', reviewAction: 'discard' }),
        run({ id: 'r-u' }),
        mergedRun({ id: 'r-a', archivedAt: '2026-08-11' }),
      ]
    );
    expect(buckets['merged-pushed']).toHaveLength(0);
    expect(buckets['merged-local']).toHaveLength(0);
  });

  test('a merged run whose ref survived a failed cleanup renders once, as the run row', () => {
    const buckets = buildLandedBuckets(
      [
        entry({
          branch: 'dispatch/t-x-r1',
          mergedIntoBase: true,
          status: 'leftover',
        }),
      ],
      [mergedRun({ id: 'r-1', pushedToOrigin: false })]
    );
    expect(buckets['merged-local'].map((r) => r.key)).toEqual(['r-1']);
  });

  test('resume chains collapse to the newest merged run per branch', () => {
    const buckets = buildLandedBuckets(
      [],
      [
        mergedRun({
          id: 'r-old',
          createdAt: '2026-08-09T00:00:00.000Z',
          pushedToOrigin: true,
        }),
        mergedRun({
          id: 'r-new',
          createdAt: '2026-08-10T00:00:00.000Z',
          pushedToOrigin: true,
        }),
      ]
    );
    expect(buckets['merged-pushed'].map((r) => r.key)).toEqual(['r-new']);
  });

  test('still-out refs bucket by their git/registry state, carrying behindBase', () => {
    const buckets = buildLandedBuckets(
      [
        entry({ branch: 'dispatch/t-a-r1', behindBase: 3 }),
        entry({ branch: 'dispatch/t-b-r1', status: 'active' }),
        entry({ branch: 'dispatch/t-c-r1', status: 'orphan' }),
      ],
      []
    );
    expect(buckets['awaiting-review'][0]?.behindBase).toBe(3);
    expect(buckets['in-progress']).toHaveLength(1);
    expect(buckets.abandoned).toHaveLength(1);
  });

  test('landed sections read newest landing first', () => {
    const buckets = buildLandedBuckets(
      [],
      [
        mergedRun({
          id: 'r-early',
          reviewedAt: '2026-08-09T00:00:00.000Z',
          pushedToOrigin: true,
        }),
        mergedRun({
          id: 'r-late',
          branch: 'dispatch/t-y-r1',
          reviewedAt: '2026-08-11T00:00:00.000Z',
          pushedToOrigin: true,
        }),
      ]
    );
    expect(buckets['merged-pushed'].map((r) => r.key)).toEqual([
      'r-late',
      'r-early',
    ]);
  });
});

describe('isStaleBranch', () => {
  const now = Date.parse('2026-08-11T12:00:00Z');

  test('older than a week is stale, newer is not, unknown never is', () => {
    expect(
      isStaleBranch(entry({ lastCommitAt: '2026-08-01T12:00:00Z' }), now)
    ).toBe(true);
    expect(
      isStaleBranch(entry({ lastCommitAt: '2026-08-10T12:00:00Z' }), now)
    ).toBe(false);
    expect(isStaleBranch(entry({}), now)).toBe(false);
  });
});
