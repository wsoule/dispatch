import type { ActorContext } from '@dispatch/core';
import { isOutstanding, parseTaskFile, TaskStore } from '@dispatch/core';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import type { GitRunner, SyncWorktree } from './worktree.js';

export interface SyncResult {
  pushed: number;
  /** How many files materialize() wrote or removed in the working tree. */
  pulled: number;
  state: SyncState;
  detail: string | null;
}

export type SyncState = 'idle' | 'local-only' | 'blocked' | 'disabled';

const TASKS_DIR = join('.dispatch', 'tasks');

// Prefers stderr, falling back to stdout — some git failures print to
// stdout (e.g. a rejected push's summary line).
function errorText(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

/**
 * Mirrors outstanding `.dispatch/tasks/*.md` files from the user's working
 * tree into the board's private sync worktree, commits them there, and
 * pushes to trunk. Reads from `rootDir` but never runs a git command or
 * writes a file there — every mutation happens inside `worktree.path`, a
 * separate checkout the user never sees.
 */
export class BoardSyncer {
  constructor(
    private readonly rootDir: string,
    private readonly worktree: SyncWorktree,
    private readonly actor: ActorContext,
    private readonly run: GitRunner
  ) {}

  // The body is synchronous (GitRunner is synchronous); the wrapper keeps
  // room for a future async step (e.g. a generated commit message).
  syncOnce(): Promise<SyncResult> {
    return Promise.resolve(this.syncOnceSync());
  }

  private syncOnceSync(): SyncResult {
    this.worktree.ensure();

    const localStore = new TaskStore(this.rootDir);
    const remoteStore = new TaskStore(this.worktree.path);
    const tasksDir = join(this.worktree.path, '.dispatch', 'tasks');

    // Only a task that moved past the sync worktree's version is mirrored —
    // a stale checkout must never push the board backwards (see 53190d6).
    const staged: string[] = [];
    for (const doc of localStore.listSafe().docs) {
      const sourceFile = localStore.taskFilePath(doc.meta.id);
      if (sourceFile === null) continue;
      let lastAccounted: string | undefined;
      try {
        lastAccounted = remoteStore.get(doc.meta.id)?.meta.updated;
      } catch {
        // A corrupt copy in the sync worktree isn't a version to hold
        // against — overwrite it.
        lastAccounted = undefined;
      }
      if (!isOutstanding(doc.meta.updated, lastAccounted)) continue;

      mkdirSync(tasksDir, { recursive: true });
      const targetFile = join(tasksDir, basename(sourceFile));
      copyFileSync(sourceFile, targetFile);
      staged.push(join('.dispatch', 'tasks', basename(sourceFile)));
    }

    if (staged.length > 0) {
      this.run(this.worktree.path, ['add', ...staged]);
      const commit = this.run(this.worktree.path, [
        'commit',
        '-m',
        this.commitMessage(staged.length),
      ]);
      if (commit.status !== 0) {
        return {
          pushed: 0,
          pulled: 0,
          state: 'blocked',
          detail: errorText(commit),
        };
      }
    }

    const trunk = this.worktree.trunkRef();

    // Captured immediately before the pull: materialize()'s diff must cover
    // exactly what the pull brings in, not this cycle's own staged commit
    // above (already reflected in this HEAD) and nothing from before it —
    // there is deliberately no persisted "last materialized" pointer to
    // fall back on (see materialize()'s doc comment for why).
    const beforePull = this.run(this.worktree.path, ['rev-parse', 'HEAD']);
    if (beforePull.status !== 0) {
      // No commit reachable in the worktree at all — possible only for a
      // genuinely empty repo. There's no safe revision to diff from, and
      // guessing one (e.g. the empty tree) is exactly the resurrection bug
      // this design avoids, so this cycle simply skips materializing.
      console.error(
        `board sync: could not resolve the sync worktree's HEAD before pulling (${this.rootDir}); skipping materialize() this cycle: ${errorText(beforePull)}`
      );
    }

    const pull = this.run(this.worktree.path, [
      'pull',
      '--rebase',
      'origin',
      trunk,
    ]);
    if (pull.status !== 0) {
      // Never leave the worktree mid-rebase — the next syncOnce() must find
      // it clean; the commit above already sits safely in its history.
      this.run(this.worktree.path, ['rebase', '--abort']);
      return {
        pushed: 0,
        pulled: 0,
        state: 'blocked',
        detail: errorText(pull),
      };
    }

    // The worktree now holds trunk's latest state (local pushes rebased onto
    // whatever else landed) — copy it into the user's working tree before
    // attempting the push, so a push failure doesn't also withhold pulled
    // content the user already has a right to see.
    const changed =
      beforePull.status === 0 ? this.materialize(beforePull.stdout.trim()) : 0;

    const push = this.run(this.worktree.path, [
      'push',
      'origin',
      `HEAD:${trunk}`,
    ]);
    if (push.status !== 0) {
      return {
        pushed: 0,
        pulled: changed,
        state: 'local-only',
        detail: errorText(push),
      };
    }

    return {
      pushed: staged.length,
      pulled: changed,
      state: 'idle',
      detail: null,
    };
  }

  /**
   * Applies exactly what changed in the sync worktree's `.dispatch/tasks`
   * between `before` and the worktree's current HEAD — added/modified paths
   * are copied into the user's working tree (gated per file by the same
   * monotonic rule as the push side, but reversed: a working-tree copy
   * newer than the incoming one is an unsynced local edit and is left alone
   * for the next syncOnce() to push), and removed paths are deleted from it.
   *
   * `before` should be a revision reachable in the sync worktree — normally
   * its own HEAD as of immediately before syncOnce()'s pull, so the range
   * covers exactly what that pull brought in. Deliberately driven by a git
   * diff over that range rather than a scan of either tree: a scan can't
   * tell "trunk never had this" apart from "the user deleted this on
   * purpose" — both look like a missing local file — and ends up
   * resurrecting deletions. A path outside the diffed range is never
   * visited, so a local deletion (which never gets staged for removal — the
   * push side has no `git rm` step) survives.
   *
   * Omitting `before` makes this a no-op (returns 0): there is deliberately
   * no persisted "last materialized" pointer and no empty-tree fallback to
   * diff from when the caller doesn't supply one. Either of those would
   * resurrect a local deletion the moment the process restarts or the
   * worktree is rebuilt (a fresh BoardSyncer, or a fresh checkout, has no
   * memory of what was already materialized, so it can't tell "nothing to
   * do" apart from "everything is new" without being told). It's also what
   * keeps a standalone call safe on a syncer whose staging loop hasn't run
   * yet: an unsynced local task was never mentioned in any range, so it's
   * never a deletion candidate. Runs regardless of which branch the working
   * tree currently has checked out — the board is trunk's state.
   */
  materialize(before?: string): number {
    if (before === undefined) return 0;
    this.worktree.ensure();

    const head = this.run(this.worktree.path, ['rev-parse', 'HEAD']);
    if (head.status !== 0) return 0;
    const after = head.stdout.trim();
    if (before === after) return 0;

    return this.applyRange(before, after);
  }

  // The one-shot worker behind materialize(): writes the added/modified set
  // and removes the deleted set for the `before..after` range.
  private applyRange(before: string, after: string): number {
    const localStore = new TaskStore(this.rootDir);
    const tasksDir = join(this.rootDir, TASKS_DIR);
    let changed = 0;

    for (const relPath of this.diffPaths(before, after, 'ACMR')) {
      const sourceFile = join(this.worktree.path, relPath);
      let incoming;
      try {
        incoming = parseTaskFile(readFileSync(sourceFile, 'utf8'), sourceFile);
      } catch {
        // A corrupt incoming file isn't a version to materialize.
        continue;
      }
      let localUpdated: string | undefined;
      try {
        localUpdated = localStore.get(incoming.meta.id)?.meta.updated;
      } catch {
        // A corrupt local copy isn't a version to hold against — overwrite it.
        localUpdated = undefined;
      }
      if (!isOutstanding(incoming.meta.updated, localUpdated)) continue;

      mkdirSync(tasksDir, { recursive: true });
      copyFileSync(sourceFile, join(tasksDir, basename(relPath)));
      changed++;
    }

    for (const relPath of this.diffPaths(before, after, 'D')) {
      const localFile = join(this.rootDir, relPath);
      if (!existsSync(localFile)) continue;
      rmSync(localFile);
      changed++;
    }

    return changed;
  }

  // Paths under `.dispatch/tasks` that changed between two worktree commits,
  // restricted to `filter`'s diff-filter letters (e.g. 'ACMR' for
  // added/modified, 'D' for deleted).
  private diffPaths(before: string, after: string, filter: string): string[] {
    const result = this.run(this.worktree.path, [
      'diff',
      '--name-only',
      `--diff-filter=${filter}`,
      before,
      after,
      '--',
      TASKS_DIR,
    ]);
    if (result.status !== 0) return [];
    return result.stdout.split('\n').filter((line) => line.trim().length > 0);
  }

  private commitMessage(count: number): string {
    const summary = count === 1 ? '1 task' : `${count} tasks`;
    return `chore(board): sync ${summary}\n\nSynced by ${this.actor.humanRef}.`;
  }
}
