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

// git's magic empty-tree object: diffing against it lists every path in the
// target tree as added. Used as materialize()'s starting point when this
// BoardSyncer has never materialized before, so a fresh worktree's entire
// initial checkout is treated as incoming rather than as a scan target.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  // The sync worktree's HEAD as of the last successful materialize() call —
  // null until the first one. Diffing forward from here (rather than
  // scanning the whole tree) is what lets a local deletion survive: a path
  // the pull never touched between then and now is never visited.
  private lastMaterializedHead: string | null = null;

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
    const changed = this.materialize();

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
   * since the last call — added/modified paths are copied into the user's
   * working tree (gated per file by the same monotonic rule as the push
   * side, but reversed: a working-tree copy newer than the incoming one is
   * an unsynced local edit and is left alone for the next syncOnce() to
   * push), and removed paths are deleted from it.
   *
   * Deliberately driven by a git diff over a HEAD range rather than a scan
   * of either tree: a scan can't tell "trunk never had this" apart from
   * "the user deleted this on purpose" — both look like a missing local
   * file — and ends up resurrecting deletions every cycle. A path outside
   * the diffed range is never visited, so a local deletion (which never
   * gets staged for removal — the push side has no `git rm` step) survives,
   * and a brand-new local task that hasn't synced yet can't be swept away
   * by a standalone call. Runs regardless of which branch the working tree
   * currently has checked out — the board is trunk's state.
   */
  materialize(): number {
    this.worktree.ensure();

    const head = this.run(this.worktree.path, ['rev-parse', 'HEAD']);
    if (head.status !== 0) return 0;
    const after = head.stdout.trim();
    const before = this.lastMaterializedHead ?? EMPTY_TREE;
    if (before === after) return 0;

    const changed = this.applyRange(before, after);
    this.lastMaterializedHead = after;
    return changed;
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
