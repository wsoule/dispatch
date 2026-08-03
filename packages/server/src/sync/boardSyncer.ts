import type { ActorContext } from '@dispatch/core';
import { isOutstanding, TaskStore } from '@dispatch/core';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
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
    const written = this.materialize();

    const push = this.run(this.worktree.path, [
      'push',
      'origin',
      `HEAD:${trunk}`,
    ]);
    if (push.status !== 0) {
      return {
        pushed: 0,
        pulled: written,
        state: 'local-only',
        detail: errorText(push),
      };
    }

    return {
      pushed: staged.length,
      pulled: written,
      state: 'idle',
      detail: null,
    };
  }

  /**
   * Copies task files from the sync worktree (trunk's latest, post-pull)
   * into the user's actual working tree, and removes files trunk no longer
   * has. Gated per file by the same monotonic rule as the push side, but
   * reversed: a working-tree copy newer than the incoming one is a local
   * edit that hasn't synced yet, and is left alone so the next syncOnce()
   * pushes it instead of losing it. Runs regardless of which branch the
   * working tree currently has checked out — the board is trunk's state.
   */
  materialize(): number {
    this.worktree.ensure();

    const localStore = new TaskStore(this.rootDir);
    const remoteStore = new TaskStore(this.worktree.path);
    const tasksDir = join(this.rootDir, '.dispatch', 'tasks');

    let written = 0;

    for (const doc of remoteStore.listSafe().docs) {
      const sourceFile = remoteStore.taskFilePath(doc.meta.id);
      if (sourceFile === null) continue;
      let localUpdated: string | undefined;
      try {
        localUpdated = localStore.get(doc.meta.id)?.meta.updated;
      } catch {
        // A corrupt local copy isn't a version to hold against — overwrite it.
        localUpdated = undefined;
      }
      if (!isOutstanding(doc.meta.updated, localUpdated)) continue;

      mkdirSync(tasksDir, { recursive: true });
      copyFileSync(sourceFile, join(tasksDir, basename(sourceFile)));
      written++;
    }

    // Anything local that trunk no longer has was deleted by a teammate —
    // syncOnce() already mirrored every outstanding local task into the
    // worktree before this runs, so a local id missing there means trunk
    // dropped it, not that it's merely unsynced.
    for (const doc of localStore.listSafe().docs) {
      if (remoteStore.taskFilePath(doc.meta.id) !== null) continue;
      const localFile = localStore.taskFilePath(doc.meta.id);
      if (localFile === null) continue;
      rmSync(localFile);
      written++;
    }

    return written;
  }

  private commitMessage(count: number): string {
    const summary = count === 1 ? '1 task' : `${count} tasks`;
    return `chore(board): sync ${summary}\n\nSynced by ${this.actor.humanRef}.`;
  }
}
