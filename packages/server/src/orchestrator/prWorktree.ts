import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import type { LandingWorktree } from '../landing.js';
import type { CommandResult, CommandRunner } from './pr.js';
import { deletePrHeadRef, PR_HEAD_REF_PREFIX } from './pr.js';
import { OrchestratorClientError, OrchestratorConflictError } from './types.js';

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
   *  gets its own `pr-<n>` child inside it. Resolved against `rootDir` when
   *  relative; refused outright (constructor throws) when it resolves
   *  anywhere inside `rootDir` itself. */
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

// True when `child` (already resolved) sits anywhere under `parent`
// (already resolved) — used to refuse a `prWorktreeDir` that would nest
// worktrees inside the very repo they're cut from.
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// The filename this manager writes into a worktree's own private git-dir
// (`.git/worktrees/<name>/`, NOT the working tree) at create() time, naming
// the PR it belongs to. Lives outside the working tree specifically so a
// `git reset --hard` inside that worktree can never touch it — it has to
// survive everything sync() does. Checked by verifyOwnership() before any
// destructive call; see the class doc comment.
const OWNERSHIP_MARKER = 'dispatch-pr-worktree';

/**
 * Cuts, keeps in sync, and retires the on-demand worktrees the PR table's
 * "review this locally" action creates — one detached checkout per PR,
 * parked at `refs/dispatch/pr/<n>` (the ref PrManager.fetchPrHead writes).
 *
 * Stateless across process restarts by design: every method either shells
 * out fresh or scans disk (see list()), rather than caching what it created.
 * A crash or restart loses nothing worth recovering — the worktrees are
 * still on disk, and the next list()/sync() call reads their real state.
 *
 * Ownership: `worktreePathFor()` computes a path from `prNumber` alone, and
 * a computed path can collide with something this manager never created —
 * a worktree a person cut by hand at the same name, or (if `prWorktreeDir`
 * is misconfigured) even the enclosing main checkout itself. sync() and
 * removeIfClean() both refuse to touch anything at that path until
 * verifyOwnership() confirms it is a worktree THIS manager created.
 */
export class PrWorktreeManager {
  private readonly ctx: PrWorktreeManagerCtx;

  constructor(ctx: PrWorktreeManagerCtx) {
    if (ctx.prWorktreeDir === undefined) {
      this.ctx = ctx;
      return;
    }
    // Resolved against rootDir — a relative value must not silently resolve
    // against whatever the process's cwd happens to be — then refused
    // outright when it resolves inside rootDir itself: a worktree parent
    // nested in the repo is exactly what would let a stale/misdirected
    // `git -C <path>` call climb up to rootDir's own checkout instead of a
    // real per-PR worktree.
    const resolved = resolve(ctx.rootDir, ctx.prWorktreeDir);
    const rootResolved = resolve(ctx.rootDir);
    if (resolved === rootResolved || isPathInside(rootResolved, resolved)) {
      throw new OrchestratorClientError(
        `prWorktreeDir (${ctx.prWorktreeDir}) resolves to ${resolved}, ` +
          `inside the project itself (${rootResolved}) — refusing to use it`
      );
    }
    this.ctx = { ...ctx, prWorktreeDir: resolved };
  }

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

  // `null` on any failure (missing binary, not a git dir, empty HEAD) —
  // callers must never read that as an oid to compare against; see sync()'s
  // and create()'s handling.
  private async tryHeadOid(path: string): Promise<string | null> {
    const result = await this.ctx.run(path, ['git', 'rev-parse', 'HEAD']);
    if (!result.ok) return null;
    const oid = result.stdout.trim();
    return oid === '' ? null : oid;
  }

  private async statusAt(path: string): Promise<CommandResult> {
    return this.ctx.run(path, ['git', 'status', '--porcelain']);
  }

  // Every worktree `git worktree list --porcelain` (run in rootDir) reports,
  // keyed by its REALPATH (git prints resolved-symlink paths — e.g. macOS
  // resolves /tmp -> /private/tmp) to whether it's a detached checkout.
  // create() always passes `--detach`, so "detached" is part of what makes
  // a worktree recognizably this manager's; a worktree on a branch checkout
  // never is. Empty map on a failed command — every lookup then misses,
  // which is the safe (nothing verified, nothing touched) direction.
  private async porcelainWorktrees(): Promise<Map<string, boolean>> {
    const result = await this.ctx.run(this.ctx.rootDir, [
      'git',
      'worktree',
      'list',
      '--porcelain',
    ]);
    const map = new Map<string, boolean>();
    if (!result.ok) return map;
    let current: string | null = null;
    let detached = false;
    const flush = (): void => {
      if (current !== null) map.set(current, detached);
    };
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        current = line.slice('worktree '.length).trim();
        detached = false;
      } else if (line.trim() === 'detached') {
        detached = true;
      }
    }
    flush();
    return map;
  }

  // The private git-dir a worktree keeps its own metadata in
  // (`<main>/.git/worktrees/<name>`) — survives `git reset --hard` (which
  // only ever touches the working tree and index), so it's where the
  // ownership marker create() writes actually lives. `null` when `path`
  // isn't inside any git checkout at all.
  private async privateGitDirAt(path: string): Promise<string | null> {
    const result = await this.ctx.run(path, ['git', 'rev-parse', '--git-dir']);
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw === '') return null;
    return isAbsolute(raw) ? raw : resolve(path, raw);
  }

  // Refuses to treat `path` as this manager's own unless ALL of: git
  // considers it a worktree of `rootDir` at all (not an arbitrary
  // directory, and not a worktree of some unrelated repo reached because a
  // misconfigured `prWorktreeDir` happened to collide with one); it's
  // detached (a branch checkout was never made by this manager); and the
  // ownership marker create() wrote for this exact PR number is still
  // there. `porcelain`, when given, is a pre-fetched porcelainWorktrees()
  // result — list() passes its own so N entries cost one
  // `git worktree list` call, not N.
  private async verifyOwnership(
    path: string,
    prNumber: number,
    porcelain?: Map<string, boolean>
  ): Promise<boolean> {
    if (!existsSync(path)) return false;
    const real = realpathSync(path);
    const entries = porcelain ?? (await this.porcelainWorktrees());
    if (entries.get(real) !== true) return false;
    const gitDir = await this.privateGitDirAt(path);
    if (gitDir === null) return false;
    const markerPath = join(gitDir, OWNERSHIP_MARKER);
    if (!existsSync(markerPath)) return false;
    try {
      return readFileSync(markerPath, 'utf8').trim() === String(prNumber);
    } catch {
      return false;
    }
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
    const gitDir = await this.privateGitDirAt(path);
    if (gitDir === null) {
      throw new OrchestratorConflictError(
        `could not resolve the git-dir for the worktree just created at ${path}`
      );
    }
    // Written now, before this method ever returns the worktree as usable —
    // verifyOwnership() checks for exactly this file before any later
    // sync()/removeIfClean() call is allowed to touch the path.
    writeFileSync(join(gitDir, OWNERSHIP_MARKER), String(prNumber));
    const headOid = await this.tryHeadOid(path);
    if (headOid === null) {
      throw new OrchestratorConflictError(
        `git rev-parse HEAD failed right after creating the worktree at ${path}`
      );
    }
    // Freshly cut from the ref the caller just fetched: nothing uncommitted,
    // and nothing yet to be behind.
    return { prNumber, path, headOid, dirty: false, behind: false };
  }

  // No worktree on disk -> null. Not this manager's own -> null, refused
  // (see verifyOwnership; logged rather than silent). Dirty, or status/HEAD
  // unreadable -> returned untouched (dirty-hold); never reset blind. Clean
  // and behind -> re-fetches the PR's head and fast-forwards onto it.
  async sync(
    prNumber: number,
    headRefOid: string
  ): Promise<PrWorktreeState | null> {
    const path = this.worktreePathFor(prNumber);
    if (!existsSync(path)) return null;

    if (!(await this.verifyOwnership(path, prNumber))) {
      console.error(
        `dispatchd: refusing to sync PR #${prNumber} worktree — ${path} was not created by this manager`
      );
      return null;
    }

    const status = await this.statusAt(path);
    // An unreadable status must never read as clean — that's exactly the
    // state that would let the fast-forward branch below run a reset --hard
    // blind (Task 7 review, CRITICAL 2). Treated the same as a real dirty
    // tree: reported, untouched.
    const dirty = !status.ok || status.stdout.trim().length > 0;

    const headOid = await this.tryHeadOid(path);
    if (headOid === null) {
      // Can't even read HEAD — never compare against headRefOid (an empty
      // placeholder would read as "behind" and trigger a reset over
      // who-knows-what). Report dirty:true, the same safe "leave it alone"
      // outcome as an unreadable status.
      return { prNumber, path, headOid: '', dirty: true, behind: false };
    }
    if (dirty) {
      return {
        prNumber,
        path,
        headOid,
        dirty: true,
        behind: headOid !== headRefOid,
      };
    }
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
    const newHeadOid = await this.tryHeadOid(path);
    if (newHeadOid === null) {
      return { prNumber, path, headOid, dirty: false, behind: true };
    }
    return {
      prNumber,
      path,
      headOid: newHeadOid,
      dirty: false,
      behind: newHeadOid !== headRefOid,
    };
  }

  // Whether the worktree for `prNumber` has any git-ignored files sitting in
  // it. `git status --porcelain` (used everywhere else in this module)
  // never reports these, so a plain "clean" reading would let unattended
  // auto-removal silently delete a .env, a built node_modules, or anything
  // else nothing tracks (Task 7 review, IMPORTANT 5). Only the poll's
  // unattended cleanup checks this — see PrManager's syncPrWorktrees; a
  // human pressing "remove" can see the directory themselves first.
  async hasIgnoredFiles(prNumber: number): Promise<boolean> {
    const path = this.worktreePathFor(prNumber);
    const result = await this.ctx.run(path, [
      'git',
      'status',
      '--porcelain',
      '--ignored',
    ]);
    // Fail-closed, same posture as CRITICAL 2: an unreadable status is
    // treated as "might have ignored files", not "definitely doesn't".
    if (!result.ok) return true;
    return result.stdout.split('\n').some((line) => line.startsWith('!! '));
  }

  // No worktree on disk -> null (already gone, nothing to do). Not this
  // manager's own -> null, refused. Dirty, or status unreadable -> kept,
  // returning the state so the caller can flag it (409). Clean -> removed,
  // along with the pr head ref it was cut from.
  async removeIfClean(prNumber: number): Promise<PrWorktreeState | null> {
    const path = this.worktreePathFor(prNumber);
    if (!existsSync(path)) return null;

    if (!(await this.verifyOwnership(path, prNumber))) {
      console.error(
        `dispatchd: refusing to remove PR #${prNumber} worktree — ${path} was not created by this manager`
      );
      return null;
    }

    const status = await this.statusAt(path);
    // Same fail-closed rule as sync(): an unreadable status must never read
    // as clean, or this would `git worktree remove` blind.
    const dirty = !status.ok || status.stdout.trim().length > 0;
    if (dirty) {
      const headOid = (await this.tryHeadOid(path)) ?? '';
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

  // A stateless disk scan: every `pr-<n>` worktree THIS MANAGER created
  // (detached + carrying its ownership marker — see verifyOwnership) under
  // its parent dir, with fresh status/rev-parse per path. `behind` is
  // always false here — deciding it needs a live PR headRefOid, which a
  // disk-only scan has no way to know; the landing route (getLandingSnapshot)
  // recomputes it against PrManager.cachedPrs(), and sync() is what keeps a
  // worktree from staying behind in the first place.
  async list(): Promise<PrWorktreeState[]> {
    // `git worktree list --porcelain` prints each worktree's REAL path (e.g.
    // macOS resolves /tmp -> /private/tmp), which can differ from the
    // logical path this.parentDir() computes — resolve the parent the same
    // way before comparing, so the two don't silently fail to match.
    const parent = this.parentDir();
    const parentReal = existsSync(parent) ? realpathSync(parent) : parent;
    const porcelain = await this.porcelainWorktrees();

    const states: PrWorktreeState[] = [];
    for (const [path, detached] of porcelain) {
      if (dirname(path) !== parentReal) continue;
      const match = /^pr-(\d+)$/.exec(basename(path));
      if (match === null) continue;
      const prNumber = Number(match[1]);
      if (!detached) continue;
      if (!(await this.verifyOwnership(path, prNumber, porcelain))) continue;
      const status = await this.statusAt(path);
      const dirty = !status.ok || status.stdout.trim().length > 0;
      const headOid = (await this.tryHeadOid(path)) ?? '';
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

// GET /api/landing: maps a worktree's live state to the sync-state string
// the landing row renders. Dirty outranks behind — a worktree the reviewer
// is mid-edit on reads as dirty-hold even if it's also stale.
//
// `currentHeadRefOid`, when given, overrides `state.behind` (always false
// from list() — a disk-only scan has no live PR data to compare against;
// see Task 7 review, IMPORTANT 3) with a real comparison against the PR's
// current headRefOid — what getLandingSnapshot passes from
// PrManager.cachedPrs(). Omitted, this falls back to `state.behind` as-is,
// which is what the unit tests below exercise directly.
export function toLandingWorktree(
  state: PrWorktreeState,
  currentHeadRefOid?: string
): LandingWorktree {
  const behind =
    currentHeadRefOid !== undefined
      ? state.headOid !== currentHeadRefOid
      : state.behind;
  return {
    path: state.path,
    syncState: state.dirty ? 'dirty-hold' : behind ? 'behind' : 'synced',
    headOid: state.headOid,
  };
}
