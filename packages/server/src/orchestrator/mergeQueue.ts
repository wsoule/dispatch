import { isDone, loadConfig, type TaskStore } from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { Orchestrator } from './orchestrator.js';
import { type CommandRunner, defaultCommandRunner } from './pr.js';
import type { CommandResult } from './pr.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

// Picks whichever of a failed command's stderr/stdout actually has content,
// preferring stderr. Duplicated from pr.ts's own (unexported) helper of the
// same name rather than importing it — pr.ts deliberately keeps it private,
// and this is small enough that copying it beats widening pr.ts's exports
// for one internal helper.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

export type MergeQueueEntryState =
  | 'queued'
  | 'waiting-blockers'
  | 'rebasing'
  | 'verifying'
  | 'merging'
  | 'merged'
  | 'failed';

export interface MergeQueueEntry {
  runId: string;
  taskId: string;
  taskTitle: string;
  state: MergeQueueEntryState;
  /** Failure detail — set only once an entry lands in `failed`. */
  reason?: string;
  enqueuedAt: string;
  /** Set only once an entry lands in `merged`/`failed`. */
  finishedAt?: string;
}

export interface MergeQueueSnapshot {
  /** Pending + active entries, in queue order. */
  entries: MergeQueueEntry[];
  /** Terminal entries (merged/failed), most-recent-first, capped at 20. */
  history: MergeQueueEntry[];
}

export interface MergeQueueContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
}

const HISTORY_LIMIT = 20;

/**
 * The merge queue (spec §2): strictly serial rebase -> verify -> merge over
 * reviewed-and-approved runs, so stacked/concurrent agent branches always
 * land on a fresh base. Event-driven like EpicEngine — enqueueing and the
 * orchestrator's onRunReviewed hook both nudge the pump; there is no polling
 * loop. In-memory: a daemon restart drops the queue (v1, like epic sessions).
 *
 * `verifyCommand` is read fresh via `loadConfig(ctx.rootDir)` at the moment
 * each entry is verified (not cached at construction or per-enqueue) — this
 * mirrors how EpicEngine reads `orchestrator.epicConcurrency` fresh off
 * `loadConfig` at dispatch time, so a user editing config.yml between merges
 * takes effect on the very next entry the queue processes.
 */
export class MergeQueue {
  private readonly entries: MergeQueueEntry[] = [];
  private readonly history: MergeQueueEntry[] = [];
  private active: MergeQueueEntry | null = null;
  private pumping = false;

  constructor(
    private readonly ctx: MergeQueueContext,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {
    // A review elsewhere (local merge, PR poller) can complete a blocker —
    // re-check waiting entries whenever any run gets reviewed. Note: the
    // queue's OWN merge()/markRunMergedViaPr calls fire this same hook
    // synchronously, re-entering pump() while the outer pump() call is still
    // on the stack — the `pumping` guard below makes that a no-op instead of
    // a double-process or a deadlock.
    ctx.orchestrator.onRunReviewed(() => this.kick());
  }

  // Fire-and-forget pump trigger, shared by enqueue() and the onRunReviewed
  // hook: neither call site awaits `pump()` (an enqueue/review call must
  // return immediately, not block on however long the whole queue takes to
  // drain), so a pump-loop error must be caught right here — otherwise it
  // would surface as an unhandled promise rejection instead of a logged
  // error, mirroring PrManager.startPolling's same fire-and-forget safety
  // net around pollOnce().
  private kick(): void {
    this.pump().catch((err: unknown) => {
      console.error(
        `dispatchd: merge queue pump failed: ${(err as Error).message}`
      );
    });
  }

  // POST /api/merge-queue. Validates against the orchestrator's live
  // registry: 404 for an id it's never heard of, 409 for a run that hasn't
  // reached a terminal state yet, one that's already been reviewed (nothing
  // left to merge), or one already sitting in this queue (active or
  // pending).
  enqueue(runId: string): MergeQueueEntry {
    const meta = this.ctx.orchestrator.list().find((r) => r.id === runId);
    if (meta === undefined) {
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    }
    if (!TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(
        `run is not in a terminal state: ${runId} (state: ${meta.state})`
      );
    }
    if (meta.reviewedAt !== undefined) {
      throw new OrchestratorConflictError(
        `run has already been reviewed: ${runId}`
      );
    }
    if (this.entries.some((e) => e.runId === runId)) {
      throw new OrchestratorConflictError(
        `run is already in the merge queue: ${runId}`
      );
    }

    const entry: MergeQueueEntry = {
      runId,
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      state: 'queued',
      enqueuedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.broadcast();
    this.kick();
    return entry;
  }

  // DELETE /api/merge-queue/:runId. The entry actively being rebased/
  // verified/merged can't be pulled out from under process() — 409 instead.
  // A queued or waiting-blockers entry is removed outright.
  remove(runId: string): void {
    if (this.active !== null && this.active.runId === runId) {
      throw new OrchestratorConflictError(
        `cannot remove the actively-processing merge queue entry: ${runId}`
      );
    }
    const idx = this.entries.findIndex((e) => e.runId === runId);
    if (idx === -1) {
      throw new OrchestratorNotFoundError(
        `run not found in merge queue: ${runId}`
      );
    }
    this.entries.splice(idx, 1);
    this.broadcast();
  }

  // GET /api/merge-queue. Clones both arrays so a caller can't mutate the
  // queue's own internal state through the returned snapshot.
  snapshot(): MergeQueueSnapshot {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      history: this.history.map((e) => ({ ...e })),
    };
  }

  // One entry at a time; picks the first entry whose task's blockers are all
  // done/cancelled. Entries with unmet blockers are flipped to
  // 'waiting-blockers' (a display state — they stay in line and are
  // re-checked every pump) so an eligible entry further back in the queue
  // still gets processed instead of stalling behind them.
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    // Deliberate microtask yield before touching any entry: enqueue()/
    // remove() call `void this.pump()` without awaiting it, so without this
    // yield the synchronous prefix of an async function would cascade all
    // the way into rebase()'s first state mutation *before enqueue() even
    // returns* — a caller could never reliably observe an entry's initial
    // 'queued' state. Yielding here first guarantees enqueue()'s caller
    // always sees the entry exactly as pushed before any processing begins.
    await Promise.resolve();
    try {
      for (;;) {
        const next = this.nextEligible();
        if (next === null) return;
        this.active = next;
        await this.process(next);
        this.active = null;
      }
    } finally {
      this.pumping = false;
      this.active = null;
    }
  }

  // Scans `entries` once, building a single id -> TaskDoc map up front (per
  // the performance skill: no repeated per-entry cache scans) and updating
  // every entry's display state (queued vs waiting-blockers) in that same
  // pass, only broadcasting if something actually changed.
  private nextEligible(): MergeQueueEntry | null {
    const byId = new Map(
      this.ctx.cache.query().map((task) => [task.meta.id, task])
    );
    let changed = false;
    let eligible: MergeQueueEntry | null = null;
    for (const entry of this.entries) {
      const task = byId.get(entry.taskId);
      const blockedBy = task?.meta.blockedBy ?? [];
      const unmet = blockedBy.some((id) => {
        const blocker = byId.get(id);
        return blocker !== undefined && !isDone(blocker);
      });
      const nextState: MergeQueueEntryState = unmet
        ? 'waiting-blockers'
        : 'queued';
      if (entry.state !== nextState) {
        entry.state = nextState;
        changed = true;
      }
      if (!unmet && eligible === null) eligible = entry;
    }
    if (changed) this.broadcast();
    return eligible;
  }

  private async process(entry: MergeQueueEntry): Promise<void> {
    const meta = this.ctx.orchestrator.list().find((r) => r.id === entry.runId);
    // The run may have been reviewed or vanished (e.g. discarded directly,
    // bypassing the queue) while this entry was waiting its turn — fail it
    // cleanly rather than trying to act on a run that no longer needs it.
    if (meta === undefined) {
      entry.reason = `run no longer exists: ${entry.runId}`;
      this.finish(entry, 'failed');
      return;
    }
    if (meta.reviewedAt !== undefined) {
      entry.reason = 'run was already reviewed outside the merge queue';
      this.finish(entry, 'failed');
      return;
    }

    try {
      await this.rebase(entry, meta);
      await this.verify(entry, meta);
      await this.merge(entry, meta);
      this.finish(entry, 'merged');
    } catch (err) {
      entry.reason = (err as Error).message;
      this.finish(entry, 'failed');
    }
  }

  // Rebases the run's branch onto the current tip of its base before
  // anything is merged, so stacked/concurrent branches always land on a
  // fresh base rather than whatever they happened to fork from. A PR run
  // (prUrl set) fetches the remote base first and rebases onto
  // `origin/<base>` — its worktree's local base ref can be stale; a local
  // run rebases directly onto its local base branch. Any rebase failure
  // (a real conflict) runs `git rebase --abort` to leave the worktree clean
  // for the next attempt, then throws for `process()` to catch.
  private async rebase(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    entry.state = 'rebasing';
    this.broadcast();
    const cwd = meta.worktreePath;

    if (meta.prUrl !== undefined) {
      const fetch = await this.run(cwd, [
        'git',
        'fetch',
        'origin',
        meta.baseBranch,
      ]);
      if (!fetch.ok) {
        throw new Error(`git fetch failed: ${commandErrorText(fetch)}`);
      }
    }

    const target =
      meta.prUrl !== undefined ? `origin/${meta.baseBranch}` : meta.baseBranch;
    const rebase = await this.run(cwd, ['git', 'rebase', target]);
    if (!rebase.ok) {
      await this.run(cwd, ['git', 'rebase', '--abort']);
      throw new Error(`git rebase failed: ${commandErrorText(rebase)}`);
    }
  }

  // Runs the project's `verifyCommand` (config.yml), if any, in the run's
  // worktree after a clean rebase — a failing verify fails the entry without
  // ever touching the merge step, so a broken rebase result never lands.
  // Absent `verifyCommand` (the common case in O1) skips this entirely.
  private async verify(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    const verifyCommand = loadConfig(this.ctx.rootDir).verifyCommand;
    if (verifyCommand === undefined) return;
    entry.state = 'verifying';
    this.broadcast();
    const result = await this.run(meta.worktreePath, [
      'bash',
      '-lc',
      verifyCommand,
    ]);
    if (!result.ok) {
      throw new Error(`verify failed: ${commandErrorText(result)}`);
    }
  }

  // The terminal step: a local run goes through the orchestrator's own
  // squash-merge review path (whatever it throws — a dirty main checkout,
  // a real conflict — propagates up to process()'s catch, failing the entry
  // cleanly); a PR run force-pushes the just-rebased branch, squash-merges
  // the PR via `gh`, and records the merge on the run via
  // markRunMergedViaPr (mirroring what PrManager's own poller does once it
  // sees a PR merged).
  private async merge(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    entry.state = 'merging';
    this.broadcast();

    if (meta.prUrl !== undefined) {
      const push = await this.run(meta.worktreePath, [
        'git',
        'push',
        '--force-with-lease',
        'origin',
        meta.branch,
      ]);
      if (!push.ok) {
        throw new Error(`git push failed: ${commandErrorText(push)}`);
      }
      const merge = await this.run(this.ctx.rootDir, [
        'gh',
        'pr',
        'merge',
        meta.prUrl,
        '--squash',
      ]);
      if (!merge.ok) {
        throw new Error(`gh pr merge failed: ${commandErrorText(merge)}`);
      }
      this.ctx.orchestrator.markRunMergedViaPr(meta.id);
    } else {
      this.ctx.orchestrator.review(meta.id, 'merge');
    }
  }

  // Removes `entry` from the live queue, stamps it terminal, and files it
  // into history (most-recent-first, capped at HISTORY_LIMIT) — the one
  // place both `merged` and `failed` outcomes converge.
  private finish(entry: MergeQueueEntry, state: 'merged' | 'failed'): void {
    const idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
    entry.state = state;
    entry.finishedAt = new Date().toISOString();
    this.history.unshift(entry);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    this.broadcast();
  }

  private broadcast(): void {
    this.ctx.events.broadcast({ type: 'merge-queue.changed' });
  }
}
