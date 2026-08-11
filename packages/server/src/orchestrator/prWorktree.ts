import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { LandingWorktree } from '../landing.js';
import type { CommandResult, CommandRunner } from './pr.js';
import { deletePrHeadRef, PR_HEAD_REF_PREFIX } from './pr.js';
import { OrchestratorConflictError } from './types.js';

// One PR's review worktree as it stands on disk right now — never persisted,
// always recomputed from git (see PrWorktreeManager.list()).
export interface PrWorktreeState {
  prNumber: number;
  path: string;
  /** `git rev-parse HEAD` in the worktree. */
  headOid: string;
  /** `git status --porcelain` is non-empty. */
  dirty: boolean;
  /** `headOid` no longer matches the PR's current head on GitHub. */
  behind: boolean;
}

export interface PrWorktreeManagerCtx {
  rootDir: string;
  run: CommandRunner;
  /** Overrides the PARENT directory worktrees are cut into; each PR still
   *  gets its own `pr-<n>` child inside it. */
  prWorktreeDir?: string;
  /** Re-fetches a PR's head into `refs/dispatch/pr/<n>` — a closure over
   *  PrManager.fetchPrHead rather than the manager itself, so this module
   *  depends only on pr.ts's CommandRunner shape and ref naming, not its
   *  whole gh/GitHub surface. */
  fetchHead: (prNumber: number) => Promise<void>;
}

function prHeadRef(prNumber: number): string {
  return `${PR_HEAD_REF_PREFIX}${prNumber}`;
}

// Picks whichever of a failed command's stderr/stdout actually has content,
// preferring stderr — mirrors pr.ts's own commandErrorText (not exported).
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

/**
 * Cuts, keeps in sync, and retires the on-demand worktrees the PR table's
 * "review this locally" action creates — one detached checkout per PR,
 * parked at `refs/dispatch/pr/<n>` (the ref PrManager.fetchPrHead writes).
 *
 * Stateless across process restarts by design: every method either shells
 * out fresh or scans disk (see list()), rather than caching what it created.
 * A crash or restart loses nothing worth recovering — the worktrees are
 * still on disk, and the next list()/sync() call reads their real state.
 */
export class PrWorktreeManager {
  constructor(private readonly ctx: PrWorktreeManagerCtx) {}

  private parentDir(): string {
    if (this.ctx.prWorktreeDir !== undefined) return this.ctx.prWorktreeDir;
    return join(
      dirname(this.ctx.rootDir),
      `${basename(this.ctx.rootDir)}-worktrees`
    );
  }

  worktreePathFor(prNumber: number): string {
    return join(this.parentDir(), `pr-${prNumber}`);
  }

  private async headOidAt(path: string): Promise<string> {
    const result = await this.ctx.run(path, ['git', 'rev-parse', 'HEAD']);
    return result.ok ? result.stdout.trim() : '';
  }

  private async statusAt(path: string): Promise<CommandResult> {
    return this.ctx.run(path, ['git', 'status', '--porcelain']);
  }

  // The caller (the API route) has already fetched refs/dispatch/pr/<n>
  // behind the fork gate — this only cuts the checkout from a ref it
  // assumes exists.
  async create(prNumber: number): Promise<PrWorktreeState> {
    const path = this.worktreePathFor(prNumber);
    mkdirSync(dirname(path), { recursive: true });
    const add = await this.ctx.run(this.ctx.rootDir, [
      'git',
      'worktree',
      'add',
      '--detach',
      path,
      prHeadRef(prNumber),
    ]);
    if (!add.ok) {
      throw new OrchestratorConflictError(
        `git worktree add failed: ${commandErrorText(add)}`
      );
    }
    const headOid = await this.headOidAt(path);
    // Freshly cut from the ref the caller just fetched: nothing uncommitted,
    // and nothing yet to be behind.
    return { prNumber, path, headOid, dirty: false, behind: false };
  }

  // No worktree on disk -> null. Dirty -> returned untouched (dirty-hold);
  // never reset over a reviewer's uncommitted notes. Clean and behind ->
  // re-fetches the PR's head and fast-forwards onto it.
  async sync(
    prNumber: number,
    headRefOid: string
  ): Promise<PrWorktreeState | null> {
    const path = this.worktreePathFor(prNumber);
    if (!existsSync(path)) return null;

    const status = await this.statusAt(path);
    const dirty = status.ok && status.stdout.trim().length > 0;
    if (dirty) {
      const headOid = await this.headOidAt(path);
      return {
        prNumber,
        path,
        headOid,
        dirty: true,
        behind: headOid !== headRefOid,
      };
    }

    let headOid = await this.headOidAt(path);
    if (headOid === headRefOid) {
      return { prNumber, path, headOid, dirty: false, behind: false };
    }

    // Clean and behind: safe to fast-forward. A failed fetch/reset is
    // reported as still-behind rather than thrown — one PR's flaky network
    // call must not abort the whole poll pass (see PrManager.pollOnce).
    try {
      await this.ctx.fetchHead(prNumber);
    } catch {
      return { prNumber, path, headOid, dirty: false, behind: true };
    }
    const reset = await this.ctx.run(path, [
      'git',
      'reset',
      '--hard',
      prHeadRef(prNumber),
    ]);
    if (!reset.ok) {
      return { prNumber, path, headOid, dirty: false, behind: true };
    }
    headOid = await this.headOidAt(path);
    return {
      prNumber,
      path,
      headOid,
      dirty: false,
      behind: headOid !== headRefOid,
    };
  }

  // No worktree on disk -> null (already gone, nothing to do). Dirty -> kept,
  // returning the state so the caller can flag it (409). Clean -> removed,
  // along with the pr head ref it was cut from.
  async removeIfClean(prNumber: number): Promise<PrWorktreeState | null> {
    const path = this.worktreePathFor(prNumber);
    if (!existsSync(path)) return null;

    const status = await this.statusAt(path);
    const dirty = status.ok && status.stdout.trim().length > 0;
    if (dirty) {
      const headOid = await this.headOidAt(path);
      return { prNumber, path, headOid, dirty: true, behind: false };
    }

    const remove = await this.ctx.run(this.ctx.rootDir, [
      'git',
      'worktree',
      'remove',
      path,
    ]);
    if (!remove.ok) {
      throw new OrchestratorConflictError(
        `git worktree remove failed: ${commandErrorText(remove)}`
      );
    }
    await deletePrHeadRef(this.ctx.run, this.ctx.rootDir, prNumber);
    return null;
  }

  // A stateless disk scan: every `pr-<n>` worktree git currently knows about
  // under this manager's parent dir, with fresh status/rev-parse per path.
  // `behind` is always false here — deciding it needs a live PR headRefOid,
  // which a disk-only scan has no way to know; sync() is what keeps a
  // worktree from staying behind in the first place.
  async list(): Promise<PrWorktreeState[]> {
    // `git worktree list --porcelain` prints each worktree's REAL path (e.g.
    // macOS resolves /tmp -> /private/tmp), which can differ from the
    // logical path this.parentDir() computes — resolve the parent the same
    // way before comparing, so the two don't silently fail to match.
    const parent = this.parentDir();
    const parentReal = existsSync(parent) ? realpathSync(parent) : parent;
    const result = await this.ctx.run(this.ctx.rootDir, [
      'git',
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (!result.ok) return [];

    const paths: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length).trim();
      if (dirname(path) === parentReal) paths.push(path);
    }

    const states: PrWorktreeState[] = [];
    for (const path of paths) {
      const match = /^pr-(\d+)$/.exec(basename(path));
      if (match === null) continue;
      const prNumber = Number(match[1]);
      const status = await this.statusAt(path);
      const dirty = status.ok && status.stdout.trim().length > 0;
      const headOid = await this.headOidAt(path);
      states.push({
        prNumber,
        // The logical (un-resolved) path, matching create()'s own return
        // shape — not `path` itself, which is git's resolved-symlinks form
        // and would otherwise make the same worktree print two different
        // paths depending on whether it was just created or freshly listed.
        path: this.worktreePathFor(prNumber),
        headOid,
        dirty,
        behind: false,
      });
    }
    return states;
  }
}

// GET /api/landing: maps a worktree's live state to the sync-state string the
// landing row renders. Dirty outranks behind — a worktree the reviewer is
// mid-edit on reads as dirty-hold even if it's also stale.
export function toLandingWorktree(state: PrWorktreeState): LandingWorktree {
  return {
    path: state.path,
    syncState: state.dirty ? 'dirty-hold' : state.behind ? 'behind' : 'synced',
    headOid: state.headOid,
  };
}
