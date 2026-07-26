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

// One `dispatch/*` branch ref as git knows it, independent of whether any run
// registry entry still claims it — the raw input to Orchestrator.listBranches'
// git-side enumeration.
export interface BranchRef {
  branch: string;
  lastCommitAt: string;
}

// One entry from `git worktree list`, narrowed to the two fields the branches
// surface needs. `branch` is undefined for a detached-HEAD worktree, which a
// dispatch worktree never is but a user's own worktree can be.
export interface WorktreeRef {
  path: string;
  branch?: string;
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

  // Removes a run's worktree *directory* while deliberately leaving its branch
  // ref in place — the "free disk" action's git half. Reclaiming the working
  // copy is reversible (`git worktree add` can recreate it from the ref);
  // deleting the ref is not, since for an unmerged branch the ref is the only
  // remaining pointer to those commits.
  removeWorktreeOnly(path: string): void {
    runGit(this.mainRepoDir, ['worktree', 'remove', '--force', path]);
    this.prune();
  }

  // Deletes a branch ref that has no worktree of its own — the orphan-ref
  // case, where `remove()` above would be wrong because there is no directory
  // to remove. Errors are swallowed for the same reason `remove()` swallows
  // them: the caller's goal is "no such ref", which a missing ref already
  // satisfies.
  removeBranchRef(branch: string): void {
    runGit(this.mainRepoDir, ['branch', '-D', branch]);
    this.prune();
  }

  // Every branch ref under `refs/heads/<prefix>` with its tip's commit date.
  // Enumerating from git (rather than from the run registry) is what makes an
  // orphaned ref visible at all: `pruneOrphans` below scans the worktrees
  // *directory*, so a ref whose directory is already gone is invisible to it.
  //
  // The `%09` in the format is a literal tab — chosen as the field separator
  // because a git branch name can contain almost anything except a tab.
  listBranches(prefix: string): BranchRef[] {
    const result = runGit(this.mainRepoDir, [
      'for-each-ref',
      '--format=%(refname:short)%09%(committerdate:iso-strict)',
      `refs/heads/${prefix}`,
    ]);
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab === -1
          ? { branch: line.trim(), lastCommitAt: '' }
          : {
              branch: line.slice(0, tab),
              lastCommitAt: line.slice(tab + 1).trim(),
            };
      });
  }

  // Every worktree git currently knows about, including the main checkout
  // itself. `--porcelain` emits one blank-line-separated record per worktree
  // (`worktree <path>`, then `HEAD <sha>`, then either `branch <ref>` or
  // `detached`), which is parsed line-by-line here rather than by splitting on
  // blank lines so a trailing/missing separator can't drop the last record.
  listWorktrees(): WorktreeRef[] {
    const result = runGit(this.mainRepoDir, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (!result.ok) return [];
    const entries: WorktreeRef[] = [];
    let current: WorktreeRef | undefined;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current !== undefined) entries.push(current);
        current = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('branch ') && current !== undefined) {
        const ref = line.slice('branch '.length).trim();
        const prefix = 'refs/heads/';
        current.branch = ref.startsWith(prefix)
          ? ref.slice(prefix.length)
          : ref;
      }
    }
    if (current !== undefined) entries.push(current);
    return entries;
  }

  // How many commits `branch` has that `base` does not — i.e. how much work
  // would be lost by deleting it. `base..branch` is already relative to the
  // two refs' merge base, so a base branch that moved on since the worktree
  // was created never inflates this count. Returns 0 when either ref is
  // missing (an orphan ref whose recorded base branch is itself gone), since
  // "unknown" and "nothing to lose" are both better served by the caller's
  // unmerged guard than by throwing here.
  aheadCount(branch: string, base: string): number {
    const result = runGit(this.mainRepoDir, [
      'rev-list',
      '--count',
      `${base}..${branch}`,
    ]);
    if (!result.ok) return 0;
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // True when every commit on `branch` is already reachable from `base` —
  // proof that deleting the ref destroys nothing. `merge-base --is-ancestor`
  // signals the answer through its exit code (0 = ancestor) and prints
  // nothing, so `ok` *is* the result here.
  isMergedInto(branch: string, base: string): boolean {
    return runGit(this.mainRepoDir, [
      'merge-base',
      '--is-ancestor',
      branch,
      base,
    ]).ok;
  }

  // Whether a run's worktree has uncommitted work sitting in it. Runs in the
  // worktree itself, not the main checkout — unlike `isMainDirty()` below,
  // which deliberately asks about the user's own checkout. A path that no
  // longer exists is reported clean rather than throwing: the branches surface
  // lists refs whose directory may already be gone.
  isWorktreeDirty(path: string): boolean {
    if (!existsSync(path)) return false;
    const status = runGit(path, ['status', '--porcelain']);
    return status.ok && status.stdout.trim().length > 0;
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

  // The merge base of `baseBranch` and `HEAD` in `worktreePath` — a base
  // branch that moved on since the worktree was created must not pollute a
  // diff with unrelated upstream commits, so every diff method below anchors
  // on this rather than `baseBranch` directly. Falls back to `baseBranch`
  // itself on a git error (no shared history — shouldn't happen for a
  // worktree actually branched from it, but a hard failure here would take
  // the whole diff down with it).
  private mergeBaseWith(worktreePath: string, baseBranch: string): string {
    const result = runGit(worktreePath, ['merge-base', baseBranch, 'HEAD']);
    return result.ok ? result.stdout.trim() : baseBranch;
  }

  // The review surface's *live* diff: everything since the merge base,
  // including uncommitted edits and brand-new untracked files still sitting
  // in the worktree — not just what's already committed to `HEAD`. This is
  // what makes the diff update while a run is still executing (the agent's
  // edits land on disk turns before it ever runs `git commit`) and right
  // after it finishes but before the orchestrator's own auto-commit runs.
  //
  // `git diff <mergeBase>` (deliberately not `<mergeBase>...HEAD`) compares
  // the merge base directly against the working tree, which folds in both
  // committed history and anything still uncommitted in one pass. Untracked
  // files never show up in that diff at all (by design — `git diff` only
  // ever compares tracked content), so they're listed separately via `git
  // ls-files --others` and each turned into its own "added" patch via `git
  // diff --no-index` against `/dev/null`.
  diff(worktreePath: string, baseBranch: string): DiffResult {
    const mergeBase = this.mergeBaseWith(worktreePath, baseBranch);
    const patch = runGit(worktreePath, ['diff', mergeBase]);
    const nameStatus = runGit(worktreePath, [
      'diff',
      '--name-status',
      mergeBase,
    ]);
    const files = nameStatus.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { path: rest.join('\t'), status: status ?? '' };
      });

    let patchText = patch.stdout;
    const untracked = runGit(worktreePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // One `--no-index` diff per untracked file — bounded by how many
    // untracked files actually exist, no repeated scans over the same list.
    // `git diff --no-index` exits 1 (not 0) when the two sides differ, which
    // is every real file compared against an empty `/dev/null` — that exit
    // code is this command's normal "found a difference" signal, not a
    // failure, so it's read for its stdout regardless of exit code. A
    // genuinely empty file (no difference from `/dev/null`) or a binary file
    // (whose "Binary files ... differ" stdout has no diff hunks to show) is
    // skipped rather than folded into the patch as noise.
    for (const file of untracked) {
      const result = Bun.spawnSync(
        ['git', 'diff', '--no-index', '--', '/dev/null', file],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
      );
      const stdout = result.stdout.toString('utf8');
      if (stdout.trim() === '' || stdout.includes('Binary files')) continue;
      if (patchText.length > 0 && !patchText.endsWith('\n')) {
        patchText += '\n';
      }
      patchText += stdout;
      files.push({ path: file, status: 'A' });
    }

    return { patch: patchText, files };
  }

  // The *committed-only* counterpart to `diff()` above — `mergeBase...HEAD`,
  // exactly what `diff()` itself used to compute before it started folding
  // in the live working tree. `mergeRun()` needs this specific variant: its
  // `git merge --squash` only ever pulls in commits reachable from the run's
  // branch ref, never whatever happens to be sitting uncommitted in that
  // branch's worktree, so deciding *whether there's anything to squash* (and
  // persisting the diff snapshot for a run that got merged) has to match
  // what the squash-merge itself actually sees — see mergeRun()'s own
  // comment on why the live, working-tree-inclusive `diff()` would be wrong
  // there.
  diffCommittedOnly(worktreePath: string, baseBranch: string): DiffResult {
    const mergeBase = this.mergeBaseWith(worktreePath, baseBranch);
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
