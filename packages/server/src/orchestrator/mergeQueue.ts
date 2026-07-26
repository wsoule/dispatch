import {
  computeStack,
  isDone,
  loadConfig,
  type TaskStore,
} from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import { JjManager } from './jj.js';
import type { Orchestrator } from './orchestrator.js';
import { mergeQueuePath, runsDir } from './paths.js';
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

// States process() can leave an entry in mid-way through rebase -> verify ->
// merge. An entry stuck in one of these on disk when hydrate() runs means the
// previous daemon process died before finish() ever ran for it — see
// hydrate()'s comment for why that's always safe to treat as a fresh failure
// rather than an attempt to resume.
const MID_FLIGHT_STATES: ReadonlySet<MergeQueueEntryState> = new Set([
  'rebasing',
  'verifying',
  'merging',
]);

/**
 * The merge queue (spec §2): strictly serial rebase -> verify -> merge over
 * reviewed-and-approved runs, so stacked/concurrent agent branches always
 * land on a fresh base. Event-driven like EpicEngine — enqueueing and the
 * orchestrator's onRunReviewed hook both nudge the pump; there is no polling
 * loop. Persisted to `mergeQueuePath` (see persist()/hydrate()) so a daemon
 * restart reloads the queue instead of silently dropping it.
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
  // Runs that have just been merged and whose stacked dependents still need
  // restacking. Filled synchronously by the onRunReviewed hook (which fires
  // re-entrantly from inside this queue's own merge()), drained only from
  // pump()/process() so every restack runs on the pump's single thread of
  // control instead of racing the entry being processed.
  private readonly pendingRestacks: RunMeta[] = [];
  private readonly jj: JjManager;

  constructor(
    private readonly ctx: MergeQueueContext,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {
    this.jj = new JjManager(ctx.rootDir, run);
    // A review elsewhere (local merge, PR poller) can complete a blocker —
    // re-check waiting entries whenever any run gets reviewed. Note: the
    // queue's OWN merge()/markRunMergedViaPr calls fire this same hook
    // synchronously, re-entering pump() while the outer pump() call is still
    // on the stack — the `pumping` guard below makes that a no-op instead of
    // a double-process or a deadlock.
    //
    // A blocker that actually LANDED (merge, or a merged PR) is also what
    // invalidates every dependent stacked on it, so the same hook is where
    // restacking is queued up. Hooking it here rather than only after
    // process()'s own merge() is deliberate: a blocker merged entirely
    // outside the queue — a manual review from the UI, PrManager's poller —
    // leaves its dependents just as stale, and they must be restacked before
    // the queue ever tries to merge one of them.
    ctx.orchestrator.onRunReviewed((meta) => {
      if (meta.reviewAction === 'merge' || meta.reviewAction === 'pr') {
        this.pendingRestacks.push(meta);
      }
      this.kick();
    });
    this.hydrate();
    // Anything hydrate() kept as `queued` may already be eligible (or may
    // have been sitting there through however long the daemon was down) —
    // give it the same nudge a fresh enqueue() would, rather than waiting on
    // some unrelated event to trigger the first pump.
    this.kick();
  }

  // Reloads whatever the previous process last persisted (mergeQueuePath),
  // so a daemon restart doesn't silently drop queued work. Must run AFTER
  // `orchestrator.reconcileOnBoot()` has hydrated the run registry (see
  // index.ts's construction order) — otherwise every entry below would look
  // stale and get dropped.
  //
  // History is inert (already `merged`/`failed`) and carried over as-is.
  // Live `entries` need more care:
  //   - An entry stuck `rebasing`/`verifying`/`merging` means the previous
  //     process died partway through process() for it. process() only calls
  //     orchestrator.review()/markRunMergedViaPr right at the very end of
  //     merge() — the last of the three steps — so a death at any earlier
  //     point leaves the run's `reviewedAt` unset. The run is therefore
  //     still unreviewed and re-enqueueable; what's NOT safe is resuming
  //     *this* attempt's half-finished rebase/verify/merge, so the entry is
  //     filed to history as failed instead, with a reason that tells the
  //     user to re-enqueue.
  //   - A `queued`/`waiting-blockers` entry never got touched — reload it as
  //     `queued` (nextEligible() re-derives waiting-blockers on the first
  //     pump) — but only if it still points at a run that's terminal and
  //     unreviewed per the orchestrator's live registry. A run that was
  //     reviewed, discarded, or vanished entirely while the daemon was down
  //     is dropped to failed history instead of kept around forever.
  private hydrate(): void {
    const persisted = this.loadPersistedFile();
    this.history.push(...persisted.history);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);

    const runsById = new Map(
      this.ctx.orchestrator.list().map((meta) => [meta.id, meta])
    );
    for (const entry of persisted.entries) {
      if (MID_FLIGHT_STATES.has(entry.state)) {
        this.fileStaleEntry(
          entry,
          'daemon restarted mid-merge; re-enqueue to retry'
        );
        continue;
      }
      const meta = runsById.get(entry.runId);
      if (meta === undefined) {
        this.fileStaleEntry(entry, `run no longer exists: ${entry.runId}`);
        continue;
      }
      if (!TERMINAL_RUN_STATES.has(meta.state)) {
        this.fileStaleEntry(
          entry,
          `run is not in a terminal state: ${entry.runId} (state: ${meta.state})`
        );
        continue;
      }
      if (meta.reviewedAt !== undefined) {
        this.fileStaleEntry(
          entry,
          'run was already reviewed while the daemon was down'
        );
        continue;
      }
      entry.state = 'queued';
      this.entries.push(entry);
    }
    // Persist the corrected state immediately — otherwise a hydrate() that
    // dropped stale entries would leave the on-disk file describing entries
    // this process just decided to discard, until some unrelated state
    // change happened to overwrite it.
    this.persist();
  }

  // Files a reloaded entry directly into history as failed. Only used from
  // hydrate(), for entries this process never took ownership of via
  // enqueue() — finish() is the equivalent for entries actually processed
  // this run.
  private fileStaleEntry(entry: MergeQueueEntry, reason: string): void {
    entry.state = 'failed';
    entry.reason = reason;
    entry.finishedAt = new Date().toISOString();
    this.history.unshift(entry);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
  }

  // Reads mergeQueuePath, treating a missing or corrupt file as "nothing
  // persisted yet" rather than throwing — persist()'s writeFileSync is not
  // atomic, so a crash mid-write can leave truncated/garbage JSON on disk,
  // and dispatchd must still start cleanly in that case (mirrors
  // Orchestrator.diff()'s snapshot-read convention and readRegistry() in
  // @dispatch/core).
  private loadPersistedFile(): MergeQueueSnapshot {
    const path = mergeQueuePath(this.ctx.rootDir);
    if (!existsSync(path)) return { entries: [], history: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<
        Record<keyof MergeQueueSnapshot, unknown>
      >;
      return {
        entries: Array.isArray(parsed.entries)
          ? (parsed.entries as MergeQueueEntry[])
          : [],
        history: Array.isArray(parsed.history)
          ? (parsed.history as MergeQueueEntry[])
          : [],
      };
    } catch (err) {
      console.error(
        `dispatchd: failed to read merge queue state, starting empty: ${(err as Error).message}`
      );
      return { entries: [], history: [] };
    }
  }

  // Write-through persistence: called from every broadcast() site (which is
  // every state change — enqueue, remove, each process() transition, finish)
  // so the on-disk file never lags the in-memory queue. Non-atomic
  // writeFileSync with a trailing newline, same accepted convention as
  // registry.ts's writeRegistry() — a crash mid-write is handled by
  // loadPersistedFile()'s try/catch on the read side, not by avoiding the
  // write here. Best-effort: a failure here (full disk, permissions) must
  // never block the queue action that triggered it, matching
  // persistDiffSnapshot's log-and-continue convention.
  private persist(): void {
    try {
      mkdirSync(runsDir(this.ctx.rootDir), { recursive: true });
      const snapshot: MergeQueueSnapshot = {
        entries: this.entries,
        history: this.history,
      };
      writeFileSync(
        mergeQueuePath(this.ctx.rootDir),
        `${JSON.stringify(snapshot)}\n`
      );
    } catch (err) {
      console.error(
        `dispatchd: failed to persist merge queue: ${(err as Error).message}`
      );
    }
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

  // POST /api/merge-queue/stack. Enqueues every reviewable run across
  // `taskId`'s stack — the blockedBy-connected component computed by
  // `computeStack` (blockers first, topologically). Deliberately enqueues in
  // that same order: the queue's own dependency gating (nextEligible's
  // waiting-blockers check) then serializes the stack for free — the
  // earliest-enqueued member of the stack is always the first one eligible
  // to actually process, and merging it is what flips the next member's
  // blocker check to satisfied, unblocking it in turn without this method
  // needing any extra bookkeeping of its own.
  //
  // `computeStack` returns null for a task with no stack edges at all (a
  // "stack" of one) — that's still a valid target for this action, just a
  // single-task one, so the fallback order is `[taskId]` by itself.
  //
  // Each stack member resolves to its own latest run the same way the UI's
  // `latestRunByTaskId` does: `orchestrator.list()` is already
  // most-recent-first, so the first entry matching a given taskId is that
  // task's latest run. A member is skipped — never thrown for — when: the
  // task is already done/cancelled, it has no run at all, its latest run
  // isn't in the same terminal-and-unreviewed state `enqueue()` itself
  // requires, or that run is already sitting in this queue. Only when the
  // whole stack skips does this throw 409 — an all-skipped call would
  // otherwise look like a silent no-op to the caller.
  enqueueStack(taskId: string): MergeQueueEntry[] {
    const tasks = this.ctx.cache.query();
    const byId = new Map(tasks.map((t) => [t.meta.id, t]));
    const stack = computeStack(tasks, taskId);
    const order = stack !== null ? stack.order : [taskId];

    const runs = this.ctx.orchestrator.list();
    const enqueued: MergeQueueEntry[] = [];
    for (const id of order) {
      const task = byId.get(id);
      if (task !== undefined && isDone(task)) continue;
      const meta = runs.find((r) => r.taskId === id);
      if (meta === undefined) continue;
      if (!TERMINAL_RUN_STATES.has(meta.state)) continue;
      if (meta.reviewedAt !== undefined) continue;
      if (this.entries.some((e) => e.runId === meta.id)) continue;

      const entry: MergeQueueEntry = {
        runId: meta.id,
        taskId: meta.taskId,
        taskTitle: meta.taskTitle,
        state: 'queued',
        enqueuedAt: new Date().toISOString(),
      };
      this.entries.push(entry);
      enqueued.push(entry);
    }

    if (enqueued.length === 0) {
      throw new OrchestratorConflictError(
        `no reviewable runs in this stack: ${taskId}`
      );
    }
    this.broadcast();
    this.kick();
    return enqueued;
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
        // Before anything is picked up: bring every dependent of a
        // just-merged blocker back onto its new base. A dependent whose
        // blocker landed is exactly the entry nextEligible() is about to
        // consider, and it is unmergeable until this has run.
        await this.drainRestacks();
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
      // merge() reviews the run, which fires onRunReviewed and queues this
      // run's dependents for restacking. Draining here — before the entry is
      // filed as merged — means an observer that sees `merged` is looking at
      // a stack that has already been brought back onto the new base.
      await this.drainRestacks();
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
  //
  // In a jj-colocated repo this goes through `jj rebase -b` instead: jj
  // rewrites the branch AND automatically carries every descendant along with
  // it, so a dependent stacked on this branch stays stacked instead of being
  // left pointing at the pre-rebase commits. A plain `git rebase` writes new
  // commits jj reads as divergence, and descendants do not follow.
  private async rebase(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    entry.state = 'rebasing';
    this.broadcast();
    const cwd = meta.worktreePath;

    if (await this.jj.isColocated()) {
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
      const jjTarget =
        meta.prUrl !== undefined
          ? `origin/${meta.baseBranch}`
          : meta.baseBranch;
      await this.jj.restack(meta.branch, jjTarget);
      return;
    }

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

  // Works through the merged-run backlog the onRunReviewed hook fills, one
  // merged run at a time. Never throws: restacking is repair work that runs
  // *after* a merge already succeeded, so a failure here must not undo or
  // fail that merge — restackDependents records the damage on the affected
  // run, and anything unexpected above that is logged and stepped over.
  private async drainRestacks(): Promise<void> {
    for (;;) {
      const merged = this.pendingRestacks.shift();
      if (merged === undefined) return;
      try {
        await this.restackDependents(merged);
      } catch (err) {
        console.error(
          `dispatchd: failed to restack dependents of ${merged.id}: ${(err as Error).message}`
        );
      }
    }
  }

  /**
   * Once `merged` lands, every run stacked on its branch is sitting on a
   * branch that no longer exists, carrying the blocker's commits that the new
   * base now holds in squashed form. This brings each of them back onto
   * `merged.baseBranch`. Two paths, same outcome:
   *
   * - jj: `jj rebase -s roots(<stackBaseCommit>..<branch>) -d <newBase>
   *   --skip-emptied`
   * - plain git: `git rebase --onto <newBase> <stackBaseCommit> <branch>`
   *
   * Both replay ONLY the commits the dependent itself added — the range above
   * `stackBaseCommit`, the commit it was branched from at dispatch. Neither
   * may replay the whole branch: the blocker's commits are already in the new
   * base in squashed form, so replaying them duplicates the work (measured:
   * `jj rebase -b` reports "Rebased 2 commits" where only one is the
   * dependent's). A dependent with no `stackBaseCommit` recorded therefore
   * cannot be restacked safely by either path — it is flagged, not guessed at.
   *
   * Only runs in a terminal state are touched; a live agent's worktree is
   * never rewritten underneath it. Each dependent's tip is backed up first as
   * the undo path.
   */
  private async restackDependents(merged: RunMeta): Promise<void> {
    const mergedBranch = merged.branch;
    const newBase = merged.baseBranch;
    const dependents = this.ctx.orchestrator.list().filter(
      (r) =>
        r.stackParents?.includes(mergedBranch) === true &&
        // `baseBranch === mergedBranch` is what makes `newBase` the right
        // destination. A run based on a multi-parent jj merge base still has
        // other unmerged parents, and moving it onto this one blocker's base
        // would drop their work — that case needs a rebuilt merge base, not a
        // restack, so it is deliberately left alone here.
        r.baseBranch === mergedBranch &&
        TERMINAL_RUN_STATES.has(r.state) &&
        r.reviewedAt === undefined
    );
    if (dependents.length === 0) return;

    const viaJj = await this.jj.isColocated();
    // Which path a restack took decides how to read a later failure, so record
    // it once per merge rather than leaving it to be inferred.
    const now = new Date().toISOString();
    this.ctx.store.update(
      merged.taskId,
      {
        appendActivity: `${now} merge queue: restacking ${dependents.length} dependent run(s) onto ${newBase} via ${viaJj ? 'jj' : 'git rebase --onto'}`,
      },
      now
    );

    for (const dependent of dependents) {
      // Backup first — this is the undo path if the restack goes wrong. It is
      // NOT the rebase boundary: that is stackBaseCommit, recorded at
      // dispatch. Backing up the tip and then replaying from it would make
      // the replay range empty and silently rebase nothing.
      this.ctx.orchestrator.backupRunBranch(dependent.id);
      const stackBase = dependent.stackBaseCommit;
      if (stackBase === undefined) {
        this.ctx.orchestrator.flagRunRestackFailure(
          dependent.id,
          'cannot restack: no stackBaseCommit recorded for this run'
        );
        continue;
      }
      try {
        if (viaJj) {
          await this.jj.restackOnto(dependent.branch, stackBase, newBase);
        } else {
          this.ctx.orchestrator.rebaseRunOnto(dependent.id, newBase, stackBase);
        }
        this.ctx.orchestrator.resyncRunWorktree(dependent.id);
        this.ctx.orchestrator.repointRunBase(dependent.id, newBase);
      } catch (err) {
        // A dependent that can't be restacked is not a reason to fail the
        // entry that just merged successfully — record it on the run and let
        // the human sort it out, exactly like a discarded base.
        this.ctx.orchestrator.flagRunRestackFailure(
          dependent.id,
          `restack onto ${newBase} failed: ${(err as Error).message}`
        );
      }
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

  // Every state change in this class routes through here, which is exactly
  // why persist() lives here too: enqueue, remove, each process() state
  // transition, and finish all call broadcast(), so write-through
  // persistence falls out for free without a second call site to keep in
  // sync.
  private broadcast(): void {
    this.persist();
    this.ctx.events.broadcast({ type: 'merge-queue.changed' });
  }
}
