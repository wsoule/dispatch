import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  trimWorktree,
  worktreeDiskUsage,
} from '../../src/orchestrator/trim.js';
import { WorktreeManager } from '../../src/orchestrator/worktree.js';
import { initGitRepo, runGitSync, worktreeSiblingPath } from './helpers.js';

// Builds a real worktree with the two directories that actually account for a
// run's disk footprint, plus a committed source change so `diff()` has something
// real to return before and after a trim.
function makeWorktree(): {
  repo: string;
  wtPath: string;
  branch: string;
  worktrees: WorktreeManager;
} {
  const repo = initGitRepo('dispatch-trim-');
  const worktrees = new WorktreeManager(repo);
  const branch = 'dispatch/t-trim-r1';
  const wtPath = worktreeSiblingPath(repo, 'wt-trim');
  worktrees.add(wtPath, branch, 'main');

  // Every real project ignores these, and it matters here: WorktreeManager.diff()
  // deliberately folds in untracked files, so without a .gitignore the dependency
  // directories below would show up in the run's own diff. Committing one keeps
  // this fixture honest about what a real worktree looks like.
  writeFileSync(join(wtPath, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(wtPath, 'feature.txt'), 'real work\n');
  runGitSync(wtPath, ['add', '-A']);
  runGitSync(wtPath, ['commit', '-m', 'agent: add feature']);

  // 99% of a real worktree is these — measured at 641M of 648M.
  mkdirSync(join(wtPath, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(
    join(wtPath, 'node_modules', 'left-pad', 'index.js'),
    'x'.repeat(4096)
  );
  mkdirSync(join(wtPath, 'packages', 'core', 'dist'), { recursive: true });
  writeFileSync(
    join(wtPath, 'packages', 'core', 'dist', 'index.js'),
    'y'.repeat(4096)
  );
  return { repo, wtPath, branch, worktrees };
}

describe('trimWorktree', () => {
  it('reclaims dependency directories while leaving the run reviewable', () => {
    const { repo, wtPath, branch, worktrees } = makeWorktree();
    try {
      const before = worktrees.diff(wtPath, 'main');
      expect(before.files.map((f) => f.path)).toContain('feature.txt');

      const result = trimWorktree(wtPath);

      expect(existsSync(join(wtPath, 'node_modules'))).toBe(false);
      expect(existsSync(join(wtPath, 'packages', 'core', 'dist'))).toBe(false);
      expect(result.removed.sort()).toEqual([
        'node_modules',
        'packages/core/dist',
      ]);

      // The whole point: the checkout survives, so the run is still reviewable.
      // This is the assertion trim exists to protect — free-disk removes the
      // directory outright and loses exactly this.
      expect(existsSync(join(wtPath, 'feature.txt'))).toBe(true);
      const after = worktrees.diff(wtPath, 'main');
      expect(after.patch).toBe(before.patch);
      expect(runGitSync(repo, ['branch', '--list', branch])).toContain(branch);
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op on a worktree that has nothing to reclaim', () => {
    const repo = initGitRepo('dispatch-trim-empty-');
    const worktrees = new WorktreeManager(repo);
    const wtPath = worktreeSiblingPath(repo, 'wt-trim-empty');
    worktrees.add(wtPath, 'dispatch/t-trim2-r1', 'main');
    try {
      const result = trimWorktree(wtPath);
      expect(result.removed).toEqual([]);
      expect(existsSync(join(wtPath, 'README.md'))).toBe(true);
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // A worktree already removed by a review is the common case once a run is
  // merged — trimming it must not throw, or the caller has to special-case it.
  it('reports zero for a worktree that no longer exists', () => {
    const result = trimWorktree('/tmp/definitely-not-a-worktree-xyz');
    expect(result.removed).toEqual([]);
  });

  // Never touch `.git` — a worktree's gitdir link is what makes the checkout a
  // worktree at all, and the branch would become unreachable from it.
  it('leaves the git metadata alone', () => {
    const { repo, wtPath } = makeWorktree();
    try {
      trimWorktree(wtPath);
      expect(existsSync(join(wtPath, '.git'))).toBe(true);
      expect(
        runGitSync(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      ).toBe('dispatch/t-trim-r1');
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('worktreeDiskUsage', () => {
  it('splits a worktree into reclaimable dependencies and the checkout itself', () => {
    const { repo, wtPath } = makeWorktree();
    try {
      const usage = worktreeDiskUsage(wtPath);
      // Both halves are real, and the split is what makes the tradeoff legible:
      // dependencies are reinstallable, the checkout is not.
      expect(usage.dependencyBytes).toBeGreaterThan(8000);
      expect(usage.checkoutBytes).toBeGreaterThan(0);
      expect(usage.totalBytes).toBe(
        usage.dependencyBytes + usage.checkoutBytes
      );
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports zeroes for a worktree that no longer exists', () => {
    expect(worktreeDiskUsage('/tmp/definitely-not-a-worktree-xyz')).toEqual({
      dependencyBytes: 0,
      checkoutBytes: 0,
      totalBytes: 0,
    });
  });
});
