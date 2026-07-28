import type { BranchEntry } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { computeGitHealth, STALE_AFTER_MS } from './gitHealth';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const daysAgo = (n: number) =>
  new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function branch(overrides: Partial<BranchEntry>): BranchEntry {
  return {
    branch: 'dispatch/t-1',
    worktreeExists: true,
    dirty: false,
    ahead: 1,
    mergedIntoBase: false,
    pushedToOrigin: false,
    status: 'reviewable',
    ...overrides,
  };
}

describe('computeGitHealth', () => {
  test('only counts worktrees that are actually on disk', () => {
    const health = computeGitHealth(
      [
        branch({ branch: 'a', diskBytes: 100 }),
        branch({ branch: 'b', worktreeExists: false, diskBytes: 999 }),
      ],
      NOW
    );
    expect(health.branches).toBe(2);
    expect(health.onDisk).toHaveLength(1);
    expect(health.totalBytes).toBe(100);
  });

  test('reclaimable needs both landed and clean', () => {
    const health = computeGitHealth(
      [
        branch({ branch: 'landed-clean', mergedIntoBase: true, diskBytes: 10 }),
        // Landed but with uncommitted work: deleting this loses something.
        branch({
          branch: 'landed-dirty',
          mergedIntoBase: true,
          dirty: true,
          diskBytes: 20,
        }),
        branch({ branch: 'unlanded-clean', diskBytes: 40 }),
      ],
      NOW
    );
    expect(health.reclaimable.map((b) => b.branch)).toEqual(['landed-clean']);
    expect(health.reclaimableBytes).toBe(10);
    expect(health.dirty).toBe(1);
  });

  test('stale is measured from the last commit, and the boundary is exclusive', () => {
    const health = computeGitHealth(
      [
        branch({ branch: 'old', lastCommitAt: daysAgo(30), diskBytes: 500 }),
        branch({ branch: 'fresh', lastCommitAt: daysAgo(1) }),
        // Exactly at the threshold is not yet stale.
        branch({
          branch: 'edge',
          lastCommitAt: new Date(NOW - STALE_AFTER_MS).toISOString(),
        }),
        // No commit date at all is unknown, not old.
        branch({ branch: 'undated' }),
      ],
      NOW
    );
    expect(health.stale.map((b) => b.branch)).toEqual(['old']);
    expect(health.staleBytes).toBe(500);
  });

  test('leftover counts as an orphan — reviewed, but nothing owns the ref', () => {
    const health = computeGitHealth(
      [
        branch({ branch: 'o', status: 'orphan' }),
        branch({ branch: 'l', status: 'leftover' }),
        branch({ branch: 'r', status: 'reviewable' }),
      ],
      NOW
    );
    expect(health.orphans.map((b) => b.branch)).toEqual(['o', 'l']);
  });

  test('stacked branches are identified so bulk actions can leave them alone', () => {
    const health = computeGitHealth(
      [
        branch({ branch: 'on-top', stackParents: ['dispatch/t-base'] }),
        branch({ branch: 'plain', stackParents: [] }),
        branch({ branch: 'unknown' }),
      ],
      NOW
    );
    expect(health.stacked.map((b) => b.branch)).toEqual(['on-top']);
  });
});
