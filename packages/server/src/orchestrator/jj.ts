import type { CommandResult, CommandRunner } from './pr.js';
import { defaultCommandRunner } from './pr.js';

// Picks whichever of a failed command's streams actually has content,
// preferring stderr. Same helper shape as pr.ts/mergeQueue.ts keep privately —
// copied rather than shared for the same reason mergeQueue.ts copied it: it is
// three lines, and widening pr.ts's exports for it buys nothing.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

/**
 * Every jj operation the orchestrator needs, against the project's main
 * checkout. jj is used for the *commit graph* only — never for working copies:
 * secondary jj workspaces are not colocated and cannot be made colocated
 * (`jj git colocation enable` refuses outside the main workspace), so no git
 * command works inside one, and dispatch's agents, auto-commit, diffing, and
 * `gh pr create` all require a real git repo. Agents therefore keep running in
 * plain `git worktree` checkouts; jj's job is that rewriting a blocker's
 * commits automatically restacks every dependent branch built on top of it.
 *
 * Shells through the same injectable CommandRunner seam PrManager and
 * MergeQueue use, so tests stub jj entirely instead of requiring the binary.
 * Every method degrades rather than throwing on a missing binary — callers
 * fall back to the plain-git path (see MergeQueue.restackDependents).
 */
export class JjManager {
  constructor(
    private readonly rootDir: string,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  async isAvailable(): Promise<boolean> {
    const result = await this.run(this.rootDir, ['jj', '--version']);
    return result.ok;
  }

  async isColocated(): Promise<boolean> {
    const result = await this.run(this.rootDir, [
      'jj',
      'git',
      'colocation',
      'status',
    ]);
    return result.ok;
  }

  /**
   * Makes the project repo jj-colocated if it isn't already, so the restack
   * path below is available. Returns false (never throws) when jj is missing
   * or the conversion fails — the caller then uses the plain-git fallback.
   *
   * Colocation is what keeps this non-invasive in practice: `.jj/` sits beside
   * `.git/`, jj adds it to git's exclude itself, and the whole thing is
   * reversible with `jj git colocation disable`.
   */
  async ensureColocated(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    if (await this.isColocated()) return true;
    const init = await this.run(this.rootDir, [
      'jj',
      'git',
      'init',
      '--colocate',
    ]);
    if (init.ok) return true;
    // An existing non-colocated jj repo needs `colocation enable` instead —
    // `git init --colocate` refuses when .jj already exists.
    const enable = await this.run(this.rootDir, [
      'jj',
      'git',
      'colocation',
      'enable',
    ]);
    return enable.ok;
  }

  // Pushes jj's bookmarks back out to real git refs. Needed after any
  // operation that moves a bookmark, since git tooling (and dispatch's own
  // worktrees) only ever see the exported refs.
  async exportGit(): Promise<void> {
    await this.run(this.rootDir, ['jj', 'git', 'export']);
  }

  /**
   * Rebases `branch` onto `onto`. The reason jj is in this codebase: jj
   * automatically rebases every descendant of the rewritten commits and moves
   * their bookmarks with them, so restacking a blocker restacks the whole
   * stack above it in one call. A plain `git rebase` writes new commits that
   * jj reads as divergence, and descendants do NOT follow.
   */
  async restack(branch: string, onto: string): Promise<void> {
    const rebase = await this.run(this.rootDir, [
      'jj',
      'rebase',
      '-b',
      branch,
      '-d',
      onto,
    ]);
    if (!rebase.ok) {
      throw new Error(`jj rebase failed: ${commandErrorText(rebase)}`);
    }
    await this.exportGit();
  }

  /**
   * Moves ONLY the commits a dependent added on top of `stackBaseCommit` onto
   * `onto`, dropping any that `onto` already contains.
   *
   * This is the post-merge case and it needs `-s`, not `-b`. Once a blocker
   * has been squash-merged, `restack()` above would replay the blocker's own
   * commits on top of a base that already holds that work in squashed form —
   * measured: "Rebased 2 commits" where only one belongs to the dependent
   * (`.agents/ignore/spikes/jj-spike4.sh`). `roots(base..branch)` names the
   * first commit the dependent actually authored, and `--skip-emptied` drops
   * anything whose content already landed.
   */
  async restackOnto(
    branch: string,
    stackBaseCommit: string,
    onto: string
  ): Promise<void> {
    const rebase = await this.run(this.rootDir, [
      'jj',
      'rebase',
      '-s',
      `roots(${stackBaseCommit}..${branch})`,
      '-d',
      onto,
      '--skip-emptied',
    ]);
    if (!rebase.ok) {
      throw new Error(`jj rebase -s failed: ${commandErrorText(rebase)}`);
    }
    await this.exportGit();
  }

  /**
   * Creates a commit whose parents are all of `parents` and bookmarks it as
   * `bookmark`, returning that bookmark name for use as a worktree base. This
   * is how a task with two or more unmerged blockers gets a base containing
   * all of their work — git has no equivalent, which is why the plain-git
   * fallback makes such a task wait instead.
   */
  async mergeBase(parents: string[], bookmark: string): Promise<string> {
    if (parents.length < 2) {
      throw new Error(
        `mergeBase needs at least two parents, got ${parents.length}`
      );
    }
    const revArgs = parents.flatMap((p) => ['-r', p]);
    const create = await this.run(this.rootDir, ['jj', 'new', ...revArgs]);
    if (!create.ok) {
      throw new Error(`jj new failed: ${commandErrorText(create)}`);
    }
    const mark = await this.run(this.rootDir, [
      'jj',
      'bookmark',
      'create',
      bookmark,
      '-r',
      '@',
    ]);
    if (!mark.ok) {
      throw new Error(`jj bookmark create failed: ${commandErrorText(mark)}`);
    }
    await this.exportGit();
    return bookmark;
  }
}
