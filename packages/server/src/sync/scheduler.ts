import type { ActorContext } from '@dispatch/core';
import { loadConfig } from '@dispatch/core';

import type { EventBus } from '../events.js';
import { BoardSyncer } from './boardSyncer.js';
import type { GitRunner, SyncWorktree } from './worktree.js';

export interface BoardSyncSchedulerDeps {
  rootDir: string;
  worktree: SyncWorktree;
  actor: ActorContext;
  run: GitRunner;
  events: EventBus;
  /** Debounce for the sync triggered by a local task-file change. */
  debounceMs?: number;
}

// Mirrors LinearSync's DEFAULT_PUSH_DEBOUNCE_MS shape/purpose: long enough to
// coalesce an agent writing several task files (or a fast typist), short
// enough that a solo edit still reaches the board quickly.
const DEFAULT_DEBOUNCE_MS = 3_000;

/**
 * Debounces on-disk task-file changes into a single BoardSyncer.syncOnce()
 * call per burst, gated on `.dispatch/config.yml`'s `autoCommit` — the only
 * consumer of that setting. Emits `board.sync` with the SyncResult for every
 * attempt, so a UI can render a live feed without polling.
 */
export class BoardSyncScheduler {
  private readonly syncer: BoardSyncer;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  // A change arriving while a sync is already running is not lost — it's
  // answered by one more pass once the current one finishes.
  private pendingRerun = false;

  constructor(private readonly deps: BoardSyncSchedulerDeps) {
    this.syncer = new BoardSyncer(
      deps.rootDir,
      deps.worktree,
      deps.actor,
      deps.run
    );
  }

  // Config is read fresh on every check — from a file a person edits by
  // hand through Settings — so flipping the switch off takes effect on the
  // very next change rather than needing a restart. A parse failure leaves
  // the syncer standing down rather than throwing out of a timer callback.
  private autoCommitEnabled(): boolean {
    try {
      return loadConfig(this.deps.rootDir).autoCommit;
    } catch {
      return false;
    }
  }

  // A task file changed on disk: sync shortly, coalescing a burst of edits
  // (an agent writing several files, a fast typist) into one commit rather
  // than one per change. Checked here so a disabled project schedules no
  // timer at all, matching LinearSync.notifyTaskChanged's early return.
  notifyTaskChanged(): void {
    if (!this.autoCommitEnabled()) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    const delay = this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.trigger();
    }, delay);
  }

  // Runs one pass, or marks a rerun pending if one is already in flight —
  // never lets two syncOnce() calls race the same sync worktree.
  private async trigger(): Promise<void> {
    if (this.inFlight !== null) {
      this.pendingRerun = true;
      return;
    }
    const run = this.runOnce().finally(() => {
      this.inFlight = null;
      if (this.pendingRerun) {
        this.pendingRerun = false;
        void this.trigger();
      }
    });
    this.inFlight = run;
    await run;
  }

  private async runOnce(): Promise<void> {
    // Re-checked here, not just at schedule time: the debounce window gives
    // a config edit time to land between notifyTaskChanged() and this call.
    if (!this.autoCommitEnabled()) return;
    const result = await this.syncer.syncOnce();
    this.deps.events.broadcast({ type: 'board.sync', result });
  }

  // Cancels any pending debounce. Does not wait for an in-flight sync — the
  // syncer's own worktree discipline (never left mid-rebase) makes that safe
  // to abandon on shutdown.
  stop(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }
}
