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

describe('backup refs', () => {
  it('writes a backup ref at the branch tip and restores it after a rewrite', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-backup-test');
    wt.add(path, 'dispatch/t-a', base);
    writeFileSync(join(path, 'a.txt'), 'a');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'a']);

    const tip = runGitSync(path, ['rev-parse', 'HEAD']).trim();
    const saved = wt.writeBackupRef('dispatch/t-a', 'r-abc123');
    expect(saved).toBe(tip);

    // Rewrite the branch to something else, then restore. `update-ref` (not
    // `git branch -f`) is used here because the branch is checked out in the
    // worktree at `path` — `branch -f` refuses to force-move a branch used by
    // another worktree, but a real restack (via jj or a raw ref update) can
    // and does move it out from under that worktree, which is exactly the
    // scenario a backup ref exists to make reversible.
    runGitSync(repo, ['update-ref', 'refs/heads/dispatch/t-a', base]);
    expect(runGitSync(repo, ['rev-parse', 'dispatch/t-a']).trim()).not.toBe(
      tip
    );

    wt.restoreFromBackup('dispatch/t-a', 'r-abc123');
    expect(runGitSync(repo, ['rev-parse', 'dispatch/t-a']).trim()).toBe(tip);

    wt.remove(path, 'dispatch/t-a');
    rmSync(repo, { recursive: true, force: true });
  });

  it('backup refs are invisible to `git branch` and pruned by runId', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-prune-test');
    wt.add(path, 'dispatch/t-b', base);
    wt.writeBackupRef('dispatch/t-b', 'r-def456');

    expect(runGitSync(repo, ['branch', '--list'])).not.toContain('backup');
    expect(
      runGitSync(repo, ['for-each-ref', 'refs/dispatch/backup'])
    ).toContain('r-def456');

    wt.pruneBackupRefs('r-def456');
    expect(runGitSync(repo, ['for-each-ref', 'refs/dispatch/backup'])).toBe('');

    wt.remove(path, 'dispatch/t-b');
    rmSync(repo, { recursive: true, force: true });
  });

  it('writeBackupRef returns null for a branch with no tip', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    expect(wt.writeBackupRef('dispatch/does-not-exist', 'r-000000')).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('resyncToBranch', () => {
  it('reattaches a detached worktree to its branch', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-resync-test');
    wt.add(path, 'dispatch/t-c', base);
    const tip = runGitSync(path, ['rev-parse', 'HEAD']).trim();

    runGitSync(path, ['checkout', '--detach', tip]);
    expect(runGitSync(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'HEAD'
    );

    wt.resyncToBranch(path, 'dispatch/t-c');
    expect(runGitSync(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'dispatch/t-c'
    );

    wt.remove(path, 'dispatch/t-c');
    rmSync(repo, { recursive: true, force: true });
  });

  // The case the jj restack path actually produces, and the one a plain
  // `git checkout` silently fails to repair. jj's `git export` writes
  // refs/heads/<branch> from the main checkout while that branch is checked
  // out in a worktree — git only refuses that for `git branch -f`, not for a
  // raw ref write — so the worktree's HEAD symref starts resolving to the new
  // commit while its index and working tree still hold the old content.
  it('repairs a worktree whose branch ref moved underneath it', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-refmove-test');
    wt.add(path, 'dispatch/t-refmove', 'main');

    // A commit that exists only on main — the stand-in for a blocker's work
    // the restack is supposed to bring into this worktree.
    writeFileSync(join(repo, 'from-base.txt'), 'base work\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'base work']);
    const mainTip = runGitSync(repo, ['rev-parse', 'main']).trim();

    // What `jj git export` does: move the branch ref from outside the
    // worktree that has it checked out.
    runGitSync(repo, ['update-ref', 'refs/heads/dispatch/t-refmove', mainTip]);

    // HEAD already follows the moved ref, but the working tree does not: the
    // base's file is missing and git reports it as a staged deletion. This is
    // exactly the state `git checkout <branch>` cannot fix ("Already on ...").
    expect(runGitSync(path, ['rev-parse', 'HEAD']).trim()).toBe(mainTip);
    expect(existsSync(join(path, 'from-base.txt'))).toBe(false);
    expect(runGitSync(path, ['status', '--porcelain']).trim()).not.toBe('');

    wt.resyncToBranch(path, 'dispatch/t-refmove');

    expect(runGitSync(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'dispatch/t-refmove'
    );
    expect(existsSync(join(path, 'from-base.txt'))).toBe(true);
    expect(runGitSync(path, ['status', '--porcelain']).trim()).toBe('');

    wt.remove(path, 'dispatch/t-refmove');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('isDirty', () => {
  it('is false for a clean worktree and true for uncommitted content', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const path = join(repo, '..', 'wt-dirty-test');
    wt.add(path, 'dispatch/t-dirty', 'main');
    expect(wt.isDirty(path)).toBe(false);

    // Untracked counts: a hard reset would leave it, but a run holding
    // uncommitted work is exactly what must not be restacked blindly.
    writeFileSync(join(path, 'scratch.txt'), 'wip\n');
    expect(wt.isDirty(path)).toBe(true);

    runGitSync(path, ['add', '-A']);
    expect(wt.isDirty(path)).toBe(true);

    runGitSync(path, ['commit', '-m', 'wip']);
    expect(wt.isDirty(path)).toBe(false);

    wt.remove(path, 'dispatch/t-dirty');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('rebaseOnto', () => {
  // The key contract this must get right (per the plan's correction on this
  // method): `oldTip` is where the dependent branch was ORIGINALLY branched
  // from, not the dependent's own current tip and not a backup ref. Passing
  // the dependent's own tip would make `oldTip..branch` empty and rebase
  // nothing — this test sets up a real stacked scenario (dependent branched
  // from blocker while the blocker had one commit, blocker then gains a
  // second "squash" commit that supersedes it) and asserts the dependent's
  // own commit is replayed on top of the new base.
  it('replays only the dependent branch commits made since the original branch point', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();

    // Blocker branch gets one commit; this is where the dependent will
    // originally branch from (`oldTip`).
    runGitSync(repo, ['checkout', '-b', 'dispatch/blocker']);
    writeFileSync(join(repo, 'blocker.txt'), 'blocker work\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'blocker work']);
    const oldTip = runGitSync(repo, ['rev-parse', 'HEAD']).trim();

    // Dependent branches off the blocker's in-progress tip and adds its own
    // commit.
    const path = join(repo, '..', 'wt-rebase-test');
    wt.add(path, 'dispatch/dependent', 'dispatch/blocker');
    writeFileSync(join(path, 'dependent.txt'), 'dependent work\n');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'dependent work']);

    // Blocker later lands as a squash commit on `base` — this is the
    // `newBase` the dependent must be restacked onto.
    runGitSync(repo, ['checkout', base]);
    runGitSync(repo, ['merge', '--squash', 'dispatch/blocker']);
    runGitSync(repo, ['commit', '-m', 'blocker squashed onto base']);
    const newBase = runGitSync(repo, ['rev-parse', base]).trim();

    wt.rebaseOnto(path, newBase, oldTip, 'dispatch/dependent');

    // The dependent's own file must survive the rebase...
    expect(readFileSync(join(path, 'dependent.txt'), 'utf8')).toBe(
      'dependent work\n'
    );
    // ...and the new history must be newBase + exactly one replayed commit
    // (not newBase + blocker commit + dependent commit, which is what
    // passing the dependent's own tip as `oldTip` would produce).
    const log = runGitSync(path, ['log', '--pretty=%s']).trim().split('\n');
    expect(log).toEqual([
      'dependent work',
      'blocker squashed onto base',
      'initial commit',
    ]);

    wt.remove(path, 'dispatch/dependent');
    runGitSync(repo, ['branch', '-D', 'dispatch/blocker']);
    rmSync(repo, { recursive: true, force: true });
  });

  it('aborts and throws on conflict, leaving the worktree clean for a retry', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const startTip = runGitSync(repo, ['rev-parse', base]).trim();

    const path = join(repo, '..', 'wt-rebase-conflict-test');
    wt.add(path, 'dispatch/conflict', base);
    writeFileSync(join(path, 'README.md'), 'dependent edit\n');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'dependent edit']);

    // Move the base forward with a conflicting edit to the same line.
    writeFileSync(join(repo, 'README.md'), 'base edit\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'base edit']);
    const newBase = runGitSync(repo, ['rev-parse', base]).trim();

    expect(() =>
      wt.rebaseOnto(path, newBase, startTip, 'dispatch/conflict')
    ).toThrow();

    // Worktree must be left clean, no rebase in progress.
    const status = runGitSync(path, ['status', '--porcelain']).trim();
    expect(status).toBe('');

    wt.remove(path, 'dispatch/conflict');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('resolveCommit', () => {
  it('resolves a branch name to the same sha `git rev-parse` reports', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const expected = runGitSync(repo, ['rev-parse', base]).trim();

    expect(wt.resolveCommit(base)).toBe(expected);
    rmSync(repo, { recursive: true, force: true });
  });

  it('throws on an unknown ref', () => {
    const repo = initGitRepo('dispatch-wt-');
    const wt = new WorktreeManager(repo);
    expect(() => wt.resolveCommit('refs/heads/does-not-exist')).toThrow();
    rmSync(repo, { recursive: true, force: true });
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
