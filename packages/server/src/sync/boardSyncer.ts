import type { ActorContext } from '@dispatch/core';
import { isOutstanding, TaskStore } from '@dispatch/core';
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { GitRunner, SyncWorktree } from './worktree.js';

export interface SyncResult {
  pushed: number;
  /** Always 0 until Task 4 adds materialize() and wires this in. */
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

  // Wraps the (entirely synchronous, since GitRunner is synchronous) sync
  // logic in a Promise so the public surface can grow an async step later
  // (e.g. an LLM-generated commit message) without a breaking signature
  // change.
  syncOnce(): Promise<SyncResult> {
    return Promise.resolve(this.syncOnceSync());
  }

  private syncOnceSync(): SyncResult {
    this.worktree.ensure();

    const localStore = new TaskStore(this.rootDir);
    const remoteStore = new TaskStore(this.worktree.path);
    const tasksDir = join(this.worktree.path, '.dispatch', 'tasks');

    // Only a task whose content moved past what the sync worktree already
    // has gets mirrored — a stale checkout must never push the board
    // backwards (see 53190d6).
    const staged: string[] = [];
    for (const doc of localStore.listSafe().docs) {
      const sourceFile = localStore.taskFilePath(doc.meta.id);
      if (sourceFile === null) continue;
      let lastAccounted: string | undefined;
      try {
        lastAccounted = remoteStore.get(doc.meta.id)?.meta.updated;
      } catch {
        // A corrupt copy in our own sync worktree isn't a version to hold
        // against — treat it as never-accounted-for and overwrite it.
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
      // Never leave the worktree mid-rebase — a future syncOnce() must find
      // it clean, and the commit above is already safe in the sync
      // worktree's history regardless of whether this pull lands.
      this.run(this.worktree.path, ['rebase', '--abort']);
      return {
        pushed: 0,
        pulled: 0,
        state: 'blocked',
        detail: errorText(pull),
      };
    }

    const push = this.run(this.worktree.path, [
      'push',
      'origin',
      `HEAD:${trunk}`,
    ]);
    if (push.status !== 0) {
      return {
        pushed: 0,
        pulled: 0,
        state: 'local-only',
        detail: errorText(push),
      };
    }

    return { pushed: staged.length, pulled: 0, state: 'idle', detail: null };
  }

  private commitMessage(count: number): string {
    const summary = count === 1 ? '1 task' : `${count} tasks`;
    return `chore(board): sync ${summary}\n\nSynced by ${this.actor.humanRef}.`;
  }
}
