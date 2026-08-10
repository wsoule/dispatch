import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface DiffFile {
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
  // satisfied by the time `prune()` runs. Passing `runId` also drops any
  // backup refs stashed for that run: every restack writes one, and merging or
  // discarding deletes the branch they pin, so without this they would keep
  // the pre-restack commit graph alive forever and grow the ref store without
  // bound. Every production caller passes it; it stays optional only so
  // teardown helpers in tests can skip it.
  remove(path: string, branch: string, runId?: string): void {
    runGit(this.mainRepoDir, ['worktree', 'remove', '--force', path]);
    runGit(this.mainRepoDir, ['branch', '-D', branch]);
    if (runId !== undefined) this.pruneBackupRefs(runId);
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

  // True when `branch` carries at least one commit of its own and every one
  // of them is patch-equivalent to a commit already on `base` — the signature
  // a hand `git merge --squash` (or an applied patch) leaves behind. `git
  // cherry` marks each branch-only commit `-` (equivalent landed on base) or
  // `+` (missing); all-minus over a non-empty list is the proof. The
  // non-empty requirement matters: an ancestry-only check would also match a
  // run whose agent committed nothing, which must not read as merged.
  landedByPatchOn(branch: string, base: string): boolean {
    const result = runGit(this.mainRepoDir, ['cherry', base, branch]);
    if (!result.ok) return false;
    const lines = result.stdout.split('\n').filter((l) => l.trim() !== '');
    return lines.length > 0 && lines.every((l) => l.startsWith('-'));
  }

  // The commit on `base` that merged `branch` in, if one exists: a merge
  // commit in `branch..base` carrying the branch tip as a NON-first parent.
  // First-parent hits are deliberately ignored — a no-op branch's tip is just
  // an old base commit, and any later merge on base has that commit on its
  // first-parent chain, which proves nothing about THIS branch's work.
  externalMergeCommitFor(branch: string, base: string): string | undefined {
    const tip = runGit(this.mainRepoDir, ['rev-parse', `${branch}^{commit}`]);
    if (!tip.ok) return undefined;
    const tipSha = tip.stdout.trim();
    const merges = runGit(this.mainRepoDir, [
      'rev-list',
      '--min-parents=2',
      '--parents',
      `${branch}..${base}`,
    ]);
    if (!merges.ok) return undefined;
    for (const line of merges.stdout.split('\n')) {
      const [sha, , ...laterParents] = line.trim().split(/\s+/);
      if (sha !== undefined && laterParents.includes(tipSha)) return sha;
    }
    return undefined;
  }

  hasOriginRemote(): boolean {
    return runGit(this.mainRepoDir, ['remote', 'get-url', 'origin']).ok;
  }

  /**
   * Every ref whose tip has `commitish` as an ancestor — the question "what
   * in this repo vouches for this commit?". `null` when git cannot resolve
   * `commitish` at all, which is a caller's bad input rather than an answer.
   *
   * Callers use it to tell a commit the repo's own branches reach from one
   * only a fetched pull request head reaches. A SHA names the same tree as
   * the ref pointing at it, so a string rule over ref names cannot.
   */
  refsContaining(commitish: string): string[] | null {
    const result = runGit(this.mainRepoDir, [
      'for-each-ref',
      `--contains=${commitish}`,
      '--format=%(refname)',
    ]);
    if (!result.ok) return null;
    return result.stdout.split('\n').filter((line) => line.trim() !== '');
  }

  // False when origin/<base> doesn't exist locally — unpushed is the safe answer.
  isOnOriginBase(commit: string, base: string): boolean {
    return runGit(this.mainRepoDir, [
      'merge-base',
      '--is-ancestor',
      commit,
      `refs/remotes/origin/${base}`,
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

  /**
   * Where a branch's pre-restack tip is parked. Lives under `refs/dispatch/`
   * rather than `refs/heads/` so it never shows up in `git branch`, never gets
   * pushed, and can't be confused for a real branch — it is recovery state,
   * not something anyone checks out. Scoped by runId so two runs on the same
   * branch never clobber each other's backup.
   */
  backupRefName(branch: string, runId: string): string {
    return `refs/dispatch/backup/${branch}/${runId}`;
  }

  /**
   * Saves `branch`'s current tip before something rewrites it. Returns the
   * saved sha, or null when the branch has no tip yet (nothing to protect).
   *
   * This exists for two reasons at once: it makes every restack reversible,
   * and the sha it returns is exactly the `<oldTip>` argument `rebaseOnto`
   * needs to know where a dependent's own commits begin.
   */
  writeBackupRef(branch: string, runId: string): string | null {
    const tip = runGit(this.mainRepoDir, ['rev-parse', '--verify', branch]);
    if (!tip.ok) return null;
    const sha = tip.stdout.trim();
    runGit(this.mainRepoDir, [
      'update-ref',
      this.backupRefName(branch, runId),
      sha,
    ]);
    return sha;
  }

  // Points `branch` back at whatever `writeBackupRef` saved for this run.
  restoreFromBackup(branch: string, runId: string): void {
    const ref = this.backupRefName(branch, runId);
    const saved = runGit(this.mainRepoDir, ['rev-parse', '--verify', ref]);
    if (!saved.ok) return;
    runGit(this.mainRepoDir, [
      'update-ref',
      `refs/heads/${branch}`,
      saved.stdout.trim(),
    ]);
  }

  // Drops every backup ref belonging to a run — called from the same cleanup
  // path that removes its worktree and branch, so backups don't accumulate.
  pruneBackupRefs(runId: string): void {
    const refs = runGit(this.mainRepoDir, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/dispatch/backup',
    ]);
    if (!refs.ok) return;
    for (const ref of refs.stdout.split('\n')) {
      const trimmed = ref.trim();
      if (trimmed.endsWith(`/${runId}`)) {
        runGit(this.mainRepoDir, ['update-ref', '-d', trimmed]);
      }
    }
  }

  /**
   * Brings a worktree back in line with `branch` after a restack rewrote that
   * branch from the main checkout. Two different broken states have to be
   * repaired, which is why this is two commands and not one. Which one you get
   * depends on WHO moved the ref — both were measured against jj 0.43.0:
   *
   * - Detached HEAD at the pre-restack commit, with a CLEAN `git status`. This
   *   is what **jj** produces: rewriting a commit whose bookmark is checked out
   *   in a git worktree detaches that worktree rather than moving it. `git
   *   checkout <branch>` reattaches it and brings the content across, and the
   *   hard reset that follows is then a no-op.
   * - HEAD still on `branch` but the REF moved underneath the worktree. This is
   *   what a raw **`git update-ref`** produces: git writes a branch ref that is
   *   checked out elsewhere without complaint — only `git branch -f` refuses.
   *   The worktree's HEAD symref then resolves to the new commit while its
   *   index and working tree still hold the pre-restack content. Measured: in
   *   that state `git status` reports the new base's files as staged
   *   DELETIONS, and `git checkout <branch>` prints "Already on '<branch>'"
   *   and repairs nothing at all. `git reset --hard` is the only thing that
   *   actually rewrites the index and working tree here.
   *
   * The hard reset is what makes this destructive, and it is guarded twice:
   * callers check `isDirty()` first (uncommitted TRACKED changes), and the
   * untracked-collision check below covers the one case `isDirty` deliberately
   * does not. Callers MUST also only invoke this for a worktree NO live run
   * occupies — see Orchestrator.worktreeIsBusy, which is the check that
   * actually holds that line (a run's own terminal state does not, since
   * request-changes starts a fresh run in the same worktree).
   *
   * Note that both guards are checks-then-act: nothing locks the worktree, so
   * content written between the check and the reset is still lost. Terminal
   * runs have no agent writing to them, which is why that window is accepted
   * rather than closed.
   */
  resyncToBranch(worktreePath: string, branch: string): void {
    const checkout = runGit(worktreePath, ['checkout', branch]);
    if (!checkout.ok) {
      throw new Error(
        `git checkout ${branch} failed: ${checkout.stderr.trim()}`
      );
    }
    const clobbered = this.untrackedPathsInTree(worktreePath, branch);
    if (clobbered.length > 0) {
      throw new Error(
        `refusing to resync ${branch}: untracked file(s) would be overwritten: ${clobbered.join(', ')}`
      );
    }
    const reset = runGit(worktreePath, ['reset', '--hard', branch]);
    if (!reset.ok) {
      throw new Error(
        `git reset --hard ${branch} failed: ${reset.stderr.trim()}`
      );
    }
  }

  // Untracked files in `worktreePath` whose path is also tracked in `branch`'s
  // tree — precisely the ones `git reset --hard` overwrites without warning
  // (measured; non-colliding untracked files survive it untouched). Nothing
  // holds a copy of that content, so the restack refuses rather than destroy
  // it. Returns early without listing the tree at all when there is nothing
  // untracked to collide, which is the normal case: every finish path runs
  // autoCommitIfDirty before a run becomes reviewable.
  private untrackedPathsInTree(worktreePath: string, branch: string): string[] {
    const untracked = runGit(worktreePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (untracked.length === 0) return [];
    const tracked = new Set(
      runGit(worktreePath, ['ls-tree', '-r', '--name-only', branch])
        .stdout.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );
    return untracked.filter((path) => tracked.has(path));
  }

  // Whether a run's worktree has uncommitted TRACKED changes (staged or
  // unstaged). Untracked files are deliberately not counted: this is the same
  // gate `git rebase --onto` applies to itself — measured, it rebases happily
  // with untracked files present — so counting them would refuse restacks the
  // plain-git path completes without complaint. The narrower case where a
  // hard reset really would destroy untracked content is handled by
  // `resyncToBranch` above.
  //
  // Anything this reports at restack time is a cancelled run's content:
  // every other finish path already ran `autoCommitIfDirty`.
  isDirty(worktreePath: string): boolean {
    const status = runGit(worktreePath, [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    return status.stdout.trim().length > 0;
  }

  /**
   * The plain-git restack, used when jj isn't available: replays exactly the
   * commits in `oldTip..branch` (a dependent's own work) onto `newBase`,
   * dropping the blocker commits that `newBase` now already contains in
   * squashed form. Without the explicit `--onto`, a plain `git rebase newBase`
   * would try to replay the blocker's commits too and conflict against their
   * own squashed copies.
   *
   * `oldTip` is the commit the dependent branch was ORIGINALLY branched from
   * — not the dependent's own current tip, and not a backup ref. Passing the
   * dependent's own tip here would make `oldTip..branch` empty and silently
   * rebase nothing.
   *
   * Aborts and throws on conflict, leaving the worktree clean for a retry —
   * the same contract MergeQueue.rebase() already has.
   */
  rebaseOnto(
    worktreePath: string,
    newBase: string,
    oldTip: string,
    branch: string
  ): void {
    const rebase = runGit(worktreePath, [
      'rebase',
      '--onto',
      newBase,
      oldTip,
      branch,
    ]);
    if (!rebase.ok) {
      runGit(worktreePath, ['rebase', '--abort']);
      const reason = [rebase.stdout.trim(), rebase.stderr.trim()]
        .filter((s) => s.length > 0)
        .join(' | ');
      throw new Error(`git rebase --onto failed: ${reason}`);
    }
  }

  // The commit a ref currently points at, in the main checkout. Used to pin
  // down what a stacked run was branched from at the moment it was created —
  // branch refs move, commit shas don't.
  resolveCommit(ref: string): string {
    const result = runGit(this.mainRepoDir, ['rev-parse', '--verify', ref]);
    if (!result.ok) {
      throw new Error(`unable to resolve ${ref}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  // Boot-time hygiene: a directory under `worktreesRoot` that no known
  // transcript (`keepPaths`) references is a leftover from a crash.
  pruneOrphans(worktreesRoot: string, keepPaths: Set<string>): void {
    if (!existsSync(worktreesRoot)) return;
    let entries: string[];
    try {
      entries = readdirSync(worktreesRoot);
    } catch (err) {
      console.error(
        `dispatchd: skipping worktree sweep, ${worktreesRoot} is unreadable: ${(err as Error).message}`
      );
      return;
    }
    if (entries.length === 0) return;
    if (keepPaths.size === 0) {
      console.error(
        `dispatchd: skipping worktree sweep in ${worktreesRoot} — ${entries.length} worktree(s) present but no run is known to keep`
      );
      return;
    }
    this.prune();
    for (const entry of entries) {
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
    // --no-verify: the queue already verified in the worktree; pre-commit
    // hooks re-checking against stale dist would fail good merges.
    const commit = runGit(this.mainRepoDir, [
      'commit',
      '--no-verify',
      '-m',
      message,
    ]);
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
