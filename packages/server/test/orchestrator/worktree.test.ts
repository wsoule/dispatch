import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { WorktreeManager } from '../../src/orchestrator/worktree.js';
import { initGitRepo, runGitSync } from './helpers.js';

describe('WorktreeManager.defaultBaseBranch', () => {
  it('falls back to the current branch of the main checkout when there is no remote', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    expect(worktrees.defaultBaseBranch()).toBe('main');
  });

  it('prefers refs/remotes/origin/HEAD when a remote is configured', () => {
    const upstream = initGitRepo();
    runGitSync(upstream, ['checkout', '-b', 'trunk']);
    runGitSync(upstream, ['checkout', 'main']);
    runGitSync(upstream, ['branch', '-D', 'trunk']);

    const repo = initGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', upstream]);
    runGitSync(repo, ['fetch', 'origin']);
    // Simulate what `git clone` sets up: a symbolic ref pointing at the
    // remote's default branch.
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    const worktrees = new WorktreeManager(repo);
    expect(worktrees.defaultBaseBranch()).toBe('main');
  });

  // M3: a default branch containing its own `/` (e.g. `release/v2`) must
  // come back intact — only the `refs/remotes/origin/` prefix should be
  // stripped, not every path segment up to the last one.
  it('does not truncate a default branch name that itself contains a slash', () => {
    const upstream = initGitRepo();
    runGitSync(upstream, ['checkout', '-b', 'release/v2']);
    runGitSync(upstream, ['checkout', 'main']);
    runGitSync(upstream, ['branch', '-D', 'release/v2']);
    runGitSync(upstream, ['checkout', '-b', 'release/v2']);
    runGitSync(upstream, ['checkout', 'main']);

    const repo = initGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', upstream]);
    runGitSync(repo, ['fetch', 'origin']);
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/release/v2',
    ]);
    const worktrees = new WorktreeManager(repo);
    expect(worktrees.defaultBaseBranch()).toBe('release/v2');
  });
});

describe('WorktreeManager.add / remove', () => {
  it('creates a real worktree on a new branch based on the given base', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-1');

    worktrees.add(path, 'dispatch/t-abc123-fix', 'main');

    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# test repo\n');
    const branch = runGitSync(path, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim();
    expect(branch).toBe('dispatch/t-abc123-fix');

    rmSync(path, { recursive: true, force: true });
  });

  it('removes the worktree directory and deletes its branch', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-2');
    worktrees.add(path, 'dispatch/t-def456-fix', 'main');

    worktrees.remove(path, 'dispatch/t-def456-fix');

    expect(existsSync(path)).toBe(false);
    const branches = runGitSync(repo, ['branch', '--list']);
    expect(branches).not.toContain('dispatch/t-def456-fix');
  });

  it('retries once after pruning when a stale worktree directory is left on disk', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-stale');

    // Simulate a crash between "worktree add" and cleanup: create the
    // worktree, then delete its directory out from under git without
    // running `git worktree remove` first, leaving stale metadata behind.
    worktrees.add(path, 'dispatch/t-stale-fix', 'main');
    rmSync(path, { recursive: true, force: true });

    // A second add for a *different* run should still succeed by pruning
    // the stale metadata and retrying, exactly the hygiene the plan calls
    // for on `git worktree add`.
    const path2 = join(repo, '..', 'wt-stale-2');
    worktrees.add(path2, 'dispatch/t-stale2-fix', 'main');
    expect(existsSync(join(path2, 'README.md'))).toBe(true);

    rmSync(path2, { recursive: true, force: true });
  });
});

describe('WorktreeManager.isMainDirty / mergeSquash', () => {
  it('reports clean when the main checkout has no pending changes', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    expect(worktrees.isMainDirty()).toBe(false);
  });

  it('reports dirty once a file is modified in the main checkout', () => {
    const repo = initGitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    const worktrees = new WorktreeManager(repo);
    expect(worktrees.isMainDirty()).toBe(true);
  });

  it('squash-merges a worktree branch into the main checkout with one commit', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-merge');
    worktrees.add(path, 'dispatch/t-merge-fix', 'main');
    writeFileSync(join(path, 'feature.txt'), 'hello\n');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'add feature']);

    worktrees.mergeSquash(
      'dispatch/t-merge-fix',
      'dispatch: Add feature (run r-000000)'
    );

    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe('dispatch: Add feature (run r-000000)');
    // Squash merge should collapse to exactly one new commit on main.
    const count = runGitSync(repo, ['rev-list', '--count', 'HEAD']).trim();
    expect(count).toBe('2');

    rmSync(path, { recursive: true, force: true });
  });
});

describe('WorktreeManager.diff', () => {
  it('returns a real unified patch and name-status for a worktree branch', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-diff');
    worktrees.add(path, 'dispatch/t-diff-fix', 'main');
    writeFileSync(join(path, 'added.txt'), 'new content\n');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'add file']);

    const result = worktrees.diff(path, 'main');

    expect(result.patch).toContain('added.txt');
    expect(result.patch).toContain('+new content');
    expect(result.files).toEqual([{ path: 'added.txt', status: 'A' }]);

    rmSync(path, { recursive: true, force: true });
  });

  // C3 (live diff while a run executes): the whole point of `diff()` folding
  // in the working tree is that a run mid-execution — nothing committed yet
  // at all — still has a real diff to show. Covers both halves of that: an
  // uncommitted edit to a tracked file, and a brand-new untracked file.
  it('includes an uncommitted modification and an untracked file with no commits at all', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-live-diff');
    worktrees.add(path, 'dispatch/t-live-diff-fix', 'main');

    // Uncommitted edit to a file that already existed on `main` (README.md,
    // written by initGitRepo).
    writeFileSync(join(path, 'README.md'), 'edited but never committed\n');
    // Brand new file, never `git add`ed at all.
    writeFileSync(join(path, 'untracked.txt'), 'new untracked content\n');

    const result = worktrees.diff(path, 'main');

    const statusByPath = new Map(result.files.map((f) => [f.path, f.status]));
    expect(statusByPath.get('README.md')).toBe('M');
    expect(statusByPath.get('untracked.txt')).toBe('A');
    expect(result.patch).toContain('edited but never committed');
    expect(result.patch).toContain('new untracked content');

    rmSync(path, { recursive: true, force: true });
  });
});

describe('WorktreeManager.diffCommittedOnly', () => {
  // mergeRun()'s own gate needs a diff that agrees with what `git merge
  // --squash` actually sees — commits only, never the live working tree —
  // so this must NOT see an uncommitted change or an untracked file the way
  // the live `diff()` above does.
  it('ignores uncommitted changes and untracked files entirely', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-committed-only');
    worktrees.add(path, 'dispatch/t-committed-only-fix', 'main');

    writeFileSync(join(path, 'README.md'), 'edited but never committed\n');
    writeFileSync(join(path, 'untracked.txt'), 'new untracked content\n');

    const result = worktrees.diffCommittedOnly(path, 'main');

    expect(result.files).toEqual([]);
    expect(result.patch).toBe('');

    rmSync(path, { recursive: true, force: true });
  });

  it('still reports committed changes on the branch', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-committed-only-2');
    worktrees.add(path, 'dispatch/t-committed-only-fix-2', 'main');
    writeFileSync(join(path, 'added.txt'), 'new content\n');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'add file']);
    // An uncommitted change sitting alongside the real commit must still be
    // excluded.
    writeFileSync(join(path, 'added.txt'), 'new content\nplus uncommitted\n');

    const result = worktrees.diffCommittedOnly(path, 'main');

    expect(result.files).toEqual([{ path: 'added.txt', status: 'A' }]);
    expect(result.patch).toContain('+new content');
    expect(result.patch).not.toContain('plus uncommitted');

    rmSync(path, { recursive: true, force: true });
  });
});

describe('WorktreeManager.pruneOrphans', () => {
  it('removes worktree directories that are not in the keep set', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    const root = join(repo, '..', 'worktrees-root');
    mkdirSync(root, { recursive: true });
    const kept = join(root, 'kept');
    const orphan = join(root, 'orphan');
    mkdirSync(kept, { recursive: true });
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'junk.txt'), 'leftover\n');

    worktrees.pruneOrphans(root, new Set([kept]));

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('is a no-op when the worktrees root does not exist yet', () => {
    const repo = initGitRepo();
    const worktrees = new WorktreeManager(repo);
    expect(() =>
      worktrees.pruneOrphans(join(repo, '..', 'never-created'), new Set())
    ).not.toThrow();
  });
});
