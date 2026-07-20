import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DiffFile {
  path: string;
  status: string;
}

export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Runs one git command in `cwd` and captures both streams instead of
// inheriting them — every caller below needs the exact stdout/stderr text,
// either to parse it (branch names, diff output) or to fold it into a typed
// error message rather than letting git's own error text reach a client.
function runGit(cwd: string, args: string[]): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

/**
 * Owns every real git operation the orchestrator needs against the project's
 * main checkout and its dispatch worktrees: creating/removing worktrees,
 * checking the main checkout's cleanliness, squash-merging a run's branch
 * back in, and producing the unified diff a run's review surface shows.
 *
 * Every method shells out to a real `git` binary (via Bun.spawnSync) rather
 * than reimplementing git plumbing — the plan is explicit that tests must
 * assert real git effects (diff, merge, discard) against real temp repos.
 */
export class WorktreeManager {
  constructor(private readonly mainRepoDir: string) {}

  // Base branch for new worktrees: the remote's default branch when a remote
  // is configured (what `git clone` sets up as `refs/remotes/origin/HEAD`),
  // otherwise the current branch of the main checkout — the only option in
  // tests and in a freshly-initialized local repo with no remote.
  defaultBaseBranch(): string {
    const originHead = runGit(this.mainRepoDir, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    if (originHead.ok) {
      const ref = originHead.stdout.trim();
      // M3: strip only the fixed `refs/remotes/origin/` prefix — a
      // `.split('/').pop()` here would truncate any default branch name
      // that itself contains a `/` (e.g. `release/v2`) down to just `v2`.
      const prefix = 'refs/remotes/origin/';
      if (ref.startsWith(prefix)) return ref.slice(prefix.length);
    }
    const current = runGit(this.mainRepoDir, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    if (!current.ok) {
      throw new Error(
        `unable to determine current branch: ${current.stderr.trim()}`
      );
    }
    return current.stdout.trim();
  }

  // Creates a worktree at `path` on a new branch `branch`, based on
  // `baseBranch`. Vibe Kanban hygiene: prune stale worktree metadata before
  // adding (a previous crash can leave git thinking a path is still in use
  // even after the directory itself is gone), and retry once — pruning plus
  // removing any leftover directory at `path` — if the first attempt fails.
  add(path: string, branch: string, baseBranch: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.prune();
    const first = runGit(this.mainRepoDir, [
      'worktree',
      'add',
      '-b',
      branch,
      path,
      baseBranch,
    ]);
    if (first.ok) return;

    this.prune();
    rmSync(path, { recursive: true, force: true });
    runGit(this.mainRepoDir, ['branch', '-D', branch]);
    const retry = runGit(this.mainRepoDir, [
      'worktree',
      'add',
      '-b',
      branch,
      path,
      baseBranch,
    ]);
    if (!retry.ok) {
      throw new Error(`git worktree add failed: ${retry.stderr.trim()}`);
    }
  }

  // Removes a run's worktree directory and its branch. Idempotent-ish: git
  // errors from either step (e.g. the directory was already gone) are
  // swallowed since the caller's goal — no worktree, no branch — is already
  // satisfied by the time `prune()` runs.
  remove(path: string, branch: string): void {
    runGit(this.mainRepoDir, ['worktree', 'remove', '--force', path]);
    runGit(this.mainRepoDir, ['branch', '-D', branch]);
    this.prune();
  }

  prune(): void {
    runGit(this.mainRepoDir, ['worktree', 'prune']);
  }

  // Boot-time hygiene: any directory directly under `worktreesRoot` that
  // isn't referenced by a known transcript (`keepPaths`) is a leftover from
  // a crash between provisioning and cleanup — safe to delete outright.
  pruneOrphans(worktreesRoot: string, keepPaths: Set<string>): void {
    if (!existsSync(worktreesRoot)) return;
    this.prune();
    for (const entry of readdirSync(worktreesRoot)) {
      const full = join(worktreesRoot, entry);
      if (!keepPaths.has(full)) {
        rmSync(full, { recursive: true, force: true });
      }
    }
  }

  // True when the main checkout has any pending changes (staged, unstaged,
  // or untracked) — the review merge action must refuse to run while this
  // is true, per the plan's "never touch the user's working tree beyond
  // that squash commit" constraint.
  isMainDirty(): boolean {
    const status = runGit(this.mainRepoDir, ['status', '--porcelain']);
    return status.stdout.trim().length > 0;
  }

  // Squash-merges `branch` into the main checkout's current branch and
  // commits the result with `message` — runs entirely in the main checkout,
  // never the worktree. Callers must have already checked `isMainDirty()`
  // is false; this method does not re-check it.
  // True when the main checkout's index has staged changes. `git commit`
  // inside mergeSquash commits the whole index, so anything the user staged
  // before a merge would silently ride into the squash commit — the merge
  // action refuses instead.
  hasStagedChanges(): boolean {
    const staged = runGit(this.mainRepoDir, [
      'diff',
      '--cached',
      '--name-only',
    ]);
    return staged.stdout.trim().length > 0;
  }

  mergeSquash(branch: string, message: string): void {
    const merge = runGit(this.mainRepoDir, ['merge', '--squash', branch]);
    if (!merge.ok) {
      // git reports content conflicts on stdout, not stderr — include both
      // so the 409 names the conflicting files.
      const reason = [merge.stdout.trim(), merge.stderr.trim()]
        .filter((s) => s.length > 0)
        .join(' | ');
      throw new Error(`git merge --squash failed: ${reason}`);
    }
    const commit = runGit(this.mainRepoDir, ['commit', '-m', message]);
    if (!commit.ok) {
      throw new Error(`git commit failed: ${commit.stderr.trim()}`);
    }
  }

  // The review surface's diff: a unified patch plus per-file status, both
  // computed against the merge base with `baseBranch` (not `baseBranch`
  // itself) so a base branch that moved on since the worktree was created
  // doesn't pollute the diff with unrelated upstream commits.
  diff(worktreePath: string, baseBranch: string): DiffResult {
    const mergeBaseResult = runGit(worktreePath, [
      'merge-base',
      baseBranch,
      'HEAD',
    ]);
    const mergeBase = mergeBaseResult.ok
      ? mergeBaseResult.stdout.trim()
      : baseBranch;
    const range = `${mergeBase}...HEAD`;
    const patch = runGit(worktreePath, ['diff', range]);
    const nameStatus = runGit(worktreePath, ['diff', '--name-status', range]);
    const files = nameStatus.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { path: rest.join('\t'), status: status ?? '' };
      });
    return { patch: patch.stdout, files };
  }
}
