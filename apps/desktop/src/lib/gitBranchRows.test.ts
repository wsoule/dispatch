import type { BranchEntry, GitBranchWithRun } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildBranchRows, filterBranchRows } from './gitBranchRows';

function gitBranch(overrides: Partial<GitBranchWithRun>): GitBranchWithRun {
  return {
    name: 'main',
    isRemote: false,
    isCurrent: false,
    isDispatchBranch: false,
    sha: 'aaaaaaa',
    shortSha: 'aaaaaaa',
    subject: 'a commit',
    date: '2026-07-28T00:00:00.000Z',
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

function worktree(overrides: Partial<BranchEntry>): BranchEntry {
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

describe('buildBranchRows', () => {
  test('joins a git branch to its worktree entry by name', () => {
    const rows = buildBranchRows(
      [gitBranch({ name: 'dispatch/t-1' })],
      [worktree({ branch: 'dispatch/t-1', diskBytes: 42 })]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.worktree?.diskBytes).toBe(42);
  });

  test('a branch with no matching worktree entry has none', () => {
    const rows = buildBranchRows([gitBranch({ name: 'main' })], []);
    expect(rows[0]?.worktree).toBeUndefined();
  });

  test('the current branch always sorts first, regardless of worktree status', () => {
    const rows = buildBranchRows(
      [
        gitBranch({ name: 'dispatch/orphan', isCurrent: false }),
        gitBranch({ name: 'main', isCurrent: true }),
      ],
      [worktree({ branch: 'dispatch/orphan', status: 'orphan' })]
    );
    expect(rows.map((r) => r.name)).toEqual(['main', 'dispatch/orphan']);
  });

  test('among non-current branches, the neediest dispatch status sorts first', () => {
    const rows = buildBranchRows(
      [
        gitBranch({ name: 'dispatch/active' }),
        gitBranch({ name: 'dispatch/orphan' }),
        gitBranch({ name: 'plain' }),
      ],
      [
        worktree({ branch: 'dispatch/active', status: 'active' }),
        worktree({ branch: 'dispatch/orphan', status: 'orphan' }),
      ]
    );
    // orphan (rank 0) before active (rank 2) before a plain branch with no worktree (rank 3).
    expect(rows.map((r) => r.name)).toEqual([
      'dispatch/orphan',
      'dispatch/active',
      'plain',
    ]);
  });
});

describe('filterBranchRows', () => {
  test("'all' returns every row unfiltered", () => {
    const rows = buildBranchRows(
      [gitBranch({ name: 'a' }), gitBranch({ name: 'b' })],
      []
    );
    expect(filterBranchRows(rows, [], 'all')).toHaveLength(2);
  });

  test("'orphans' narrows to rows whose worktree is an orphan", () => {
    const rows = buildBranchRows(
      [gitBranch({ name: 'dispatch/o' }), gitBranch({ name: 'dispatch/a' })],
      [
        worktree({ branch: 'dispatch/o', status: 'orphan' }),
        worktree({ branch: 'dispatch/a', status: 'active' }),
      ]
    );
    const filtered = filterBranchRows(
      rows,
      [
        worktree({ branch: 'dispatch/o', status: 'orphan' }),
        worktree({ branch: 'dispatch/a', status: 'active' }),
      ],
      'orphans'
    );
    expect(filtered.map((r) => r.name)).toEqual(['dispatch/o']);
  });

  test("'dirty' narrows to on-disk worktrees with uncommitted changes", () => {
    const rows = buildBranchRows(
      [gitBranch({ name: 'dispatch/d' }), gitBranch({ name: 'dispatch/c' })],
      [
        worktree({ branch: 'dispatch/d', dirty: true }),
        worktree({ branch: 'dispatch/c', dirty: false }),
      ]
    );
    const filtered = filterBranchRows(
      rows,
      [
        worktree({ branch: 'dispatch/d', dirty: true }),
        worktree({ branch: 'dispatch/c', dirty: false }),
      ],
      'dirty'
    );
    expect(filtered.map((r) => r.name)).toEqual(['dispatch/d']);
  });
});
