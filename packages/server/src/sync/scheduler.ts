import type { ActorContext } from '@dispatch/core';
import { loadConfig } from '@dispatch/core';

import type { EventBus } from '../events.js';
import type { SyncResult } from './boardSyncer.js';
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
  /**
   * How often to run a sync even when nothing changed locally — recovers a
   * `local-only` state after a network outage, and gives a teammate who only
   * reads the board a way to see everyone else's edits. Defaults to
   * DEFAULT_PERIODIC_MS; tests pass something much shorter.
   */
  periodicMs?: number;
}

// Mirrors LinearSync's DEFAULT_PUSH_DEBOUNCE_MS shape/purpose: long enough to
// coalesce an agent writing several task files (or a fast typist), short
// enough that a solo edit still reaches the board quickly.
const DEFAULT_DEBOUNCE_MS = 3_000;

// Long enough that a healthy project barely notices the traffic; short
// enough that a silent reader or a post-outage `local-only` state recovers
// within a minute without anyone touching a task file.
const DEFAULT_PERIODIC_MS = 60_000;

/**
 * Debounces on-disk task-file changes into a single BoardSyncer.syncOnce()
 * call per burst, gated on `.dispatch/config.yml`'s `autoCommit` — the only
 * consumer of that setting. Also runs the same sync on a periodic timer
 * regardless of local edits. Emits `board.sync` with the SyncResult for
 * every attempt, so a UI can render a live feed without polling.
 */
export class BoardSyncScheduler {
  private readonly syncer: BoardSyncer;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly periodic: ReturnType<typeof setInterval>;
  private inFlight: Promise<void> | null = null;
  // A change arriving while a sync is already running is not lost — it's
  // answered by one more pass once the current one finishes.
  private pendingRerun = false;
  // The most recent attempt's outcome and when it finished, for `GET
  // /api/sync` to read without waiting on the next WS `board.sync` broadcast.
  // `null` until this scheduler has actually run once.
  private lastSyncResult: SyncResult | null = null;
  private lastSyncedAtIso: string | null = null;

  constructor(private readonly deps: BoardSyncSchedulerDeps) {
    this.syncer = new BoardSyncer(
      deps.rootDir,
      deps.worktree,
      deps.actor,
      deps.run
    );
    // Runs unconditionally so a config edit re-enabling autoCommit takes
    // effect on the next tick without a restart — the gate is checked fresh
    // on every fire, same as notifyTaskChanged's own runOnce() check, so a
    // disabled project generates no sync traffic despite the timer ticking.
    this.periodic = setInterval(() => {
      if (!this.autoCommitEnabled()) return;
      void this.trigger();
    }, deps.periodicMs ?? DEFAULT_PERIODIC_MS);
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
    this.lastSyncResult = result;
    this.lastSyncedAtIso = new Date().toISOString();
    this.deps.events.broadcast({ type: 'board.sync', result });
  }

  /** The outcome of the most recent sync attempt, or `null` before the first one. */
  lastResult(): SyncResult | null {
    return this.lastSyncResult;
  }

  /** When the most recent sync attempt finished, or `null` before the first one. */
  lastSyncedAt(): string | null {
    return this.lastSyncedAtIso;
  }

  /** Read-only tallies of what the next sync would move — see BoardSyncer.pendingCounts. */
  pendingCounts(): { outgoing: number; incoming: number } {
    return this.syncer.pendingCounts();
  }

  /**
   * Removes the sync worktree and deregisters it from `git worktree list` in
   * the user's repo — the cleanup half of enabling autoCommit, which
   * otherwise leaves a permanent full checkout under DISPATCH_HOME and a
   * permanent entry in the user's own worktree list even after the feature
   * is turned back off. A no-op if the worktree was never created (see
   * SyncWorktree.remove's own doc comment).
   */
  removeWorktree(): void {
    this.deps.worktree.remove();
  }

  // Cancels any pending debounce and the periodic timer. Does not wait for
  // an in-flight sync — the syncer's own worktree discipline (never left
  // mid-rebase) makes that safe to abandon on shutdown.
  stop(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    clearInterval(this.periodic);
  }
}
