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
import { trimWorktree } from './trim.js';
import type { RunMeta } from './types.js';
import {
  MergeEnvironmentError,
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
  return truncateReason(stderr.length > 0 ? stderr : result.stdout.trim());
}

/**
 * How much of a failure message is kept.
 *
 * A failing `bun run test` writes its entire output to stderr, and all of it
 * used to land in the entry's `reason` — which is persisted, held in memory,
 * and shipped to every client on every queue broadcast. One real queue file
 * reached 898 KB, of which 810 KB was three failure reasons.
 */
const REASON_LIMIT = 4000;

/**
 * Keeps the END of an over-long failure message.
 *
 * The tail is the useful half: a build or test log puts the summary and the
 * actual error last, while the head is setup noise. Says how much it dropped
 * rather than trailing off, so nobody mistakes a truncated log for the whole
 * failure.
 */
export function truncateReason(text: string): string {
  if (text.length <= REASON_LIMIT) return text;
  const dropped = text.length - REASON_LIMIT;
  return `…[${dropped} earlier characters omitted]\n${text.slice(-REASON_LIMIT)}`;
}

export type MergeQueueEntryState =
  | 'queued'
  | 'waiting-blockers'
  // Held because the MAIN CHECKOUT isn't mergeable-into right now — dirty
  // tree, staged index, or the wrong branch out. A display state like
  // 'waiting-blockers': the entry stays in line, carries the reason, and is
  // retried on the next pump rather than being failed out to history.
  | 'blocked-environment'
  | 'rebasing'
  | 'verifying'
  | 'merging'
  | 'merged'
  | 'failed';

/** One named verify gate's outcome on a queue entry. */
export interface VerifyStepResult {
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  /** Wall-clock duration, set once the step comes to rest. */
  ms?: number;
}

export interface MergeQueueEntry {
  runId: string;
  taskId: string;
  taskTitle: string;
  state: MergeQueueEntryState;
  /**
   * Per-step verify results, present once verification starts. Seeded as all-pending so the
   * whole pipeline is visible from the first render rather than appearing a step at a time.
   * A project with no `verifySteps` gets a single step named "verify".
   */
  steps?: VerifyStepResult[];
  /**
   * Why this entry failed or is being held — set on `failed` (terminal) and on
   * `blocked-environment` (retryable, and the one the user has to act on).
   */
  reason?: string;
  enqueuedAt: string;
  /**
   * When this entry last CHANGED state — distinct from `enqueuedAt`, which never
   * moves. The UI renders elapsed time from this ("Verifying · 4m"), which is
   * what makes a slow step distinguishable from a wedged one; an entry once sat
   * in `verifying` for 11 minutes with no process behind it and nothing said so.
   * Optional so entries persisted before this field existed hydrate unchanged.
   */
  stateSince?: string;
  /**
   * How many times this entry has been picked up after a daemon died partway
   * through processing it. Persisted with the rest of the entry, which is
   * load-bearing rather than incidental: the scenario the cap exists to stop is a
   * hang that recurs across restarts, and an in-memory counter resets to zero
   * every boot — precisely the infinite loop, with a field that looks like it
   * prevents one. Absent on entries written before this field existed, which
   * reads as zero.
   */
  attempts?: number;
  /**
   * The tail of this entry's verify output, capped at VERIFY_OUTPUT_TAIL_BYTES.
   * Exists so a client that opens mid-verify or refreshes sees recent progress
   * rather than a silent `verifying`. Bounded rather than complete on purpose: an
   * unbounded buffer against a multi-minute test suite is a leak in a long-lived
   * daemon, and the full log belongs in the failure reason, not in memory.
   */
  output?: string;
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
  // Same optional override OrchestratorContext takes, and passed the same
  // object in production (see index.ts) so the queue and the orchestrator
  // never end up talking to jj through two differently-configured managers.
  jj?: JjManager;
}

// Test-only override for the blocked-retry delay (see armBlockedRetry) —
// same injection shape as the CommandRunner constructor param, so a test can
// exercise the timer's real behavior without sleeping the production 15s.
export interface MergeQueueOptions {
  blockedRetryDelayMs?: number;
}

const HISTORY_LIMIT = 20;
const DEFAULT_BLOCKED_RETRY_DELAY_MS = 15_000;

// How many times an entry may be picked back up after a daemon died partway
// through processing it before the queue gives up on it for good. See
// MergeQueueEntry.attempts for why this must be counted on disk.
const MAX_INTERRUPTED_ATTEMPTS = 3;

// How much of an entry's verify output is retained on the entry itself. Enough
// to show what a verify was doing when it stalled or failed, small enough that a
// daemon processing many entries cannot accumulate meaningful memory.
const VERIFY_OUTPUT_TAIL_BYTES = 8192;

// States process() can leave an entry in mid-way through rebase -> verify ->
// merge. An entry found in one of these on disk when hydrate() runs means the
// previous daemon process died before finish() ever ran for it — see hydrate()
// for why that is retried rather than failed outright.
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
  // Run ids to re-examine because the run itself just reached a terminal
  // state (onRunTerminal), plus everything seeded at construction. A run that
  // was still LIVE when its blocker merged could not be restacked then — its
  // agent was using the worktree — so it is checked here instead, once it is
  // safe to touch. See restackStaleRuns().
  private readonly pendingStaleRuns: string[] = [];
  private readonly jj: JjManager;
  // Count of entries that reached `merged` since the last drain-push attempt,
  // plus the base branch the most recent of them merged into — captured at
  // increment time so a push after the counter resets (see pushOnDrain) still
  // knows what to push. Both read only by pushOnDrain, at the moment the pump
  // loop finds the queue fully empty.
  private mergedSinceIdle = 0;
  // A single field, not a per-base map: mergeRun's C4 guard refuses a merge
  // whenever the main checkout isn't on the run's own baseBranch, so this
  // one process can only ever merge against one base at a time — there is no
  // multi-base sweep for this to lose track of.
  private lastMergeBase: string | undefined;
  // Set on a drain-push failure, cleared on success — the retry seam pump()
  // checks on every subsequent idle transition (including one driven by
  // recheck(), the same "retry now" entry point 'blocked-environment' uses)
  // so a transient push failure doesn't require a fresh merge to retry.
  private lastDrainPushFailed = false;
  // refreshRemote()'s fetch failure is logged once per process, not once per
  // 60s tick — an offline remote would otherwise spam the log forever.
  private fetchFailureLogged = false;
  // Self-retry timer for a 'blocked-environment' entry — see armBlockedRetry.
  private blockedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // Overridable via `opts` so tests can observe the real self-retry firing
  // without sleeping the production delay.
  private readonly blockedRetryDelayMs: number;
  // The 60s remote-refresh tick — same timer bin.ts used to own directly;
  // moved in here so stop() has one place to tear both timers down.
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: MergeQueueContext,
    private readonly run: CommandRunner = defaultCommandRunner,
    opts?: MergeQueueOptions
  ) {
    this.blockedRetryDelayMs =
      opts?.blockedRetryDelayMs ?? DEFAULT_BLOCKED_RETRY_DELAY_MS;
    this.jj = ctx.jj ?? new JjManager(ctx.rootDir, run);
    // Everything queued holds its worktree. Without this a review of a sibling
    // run removes the directory the queue is about to rebase in, and the only
    // symptom is an ENOENT that names git rather than the missing checkout.
    ctx.orchestrator.onWorktreeClaim((worktreePath) =>
      this.entries.some((entry) => {
        const meta = this.ctx.orchestrator.getRun(entry.runId)?.meta;
        return meta?.worktreePath === worktreePath;
      })
    );
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
    // The other half of the same job. A dependent that was still LIVE when
    // its blocker merged is deliberately skipped by restackDependents (its
    // agent owns that worktree), and that is the DESIGNED shape of stacking:
    // a task is dispatched off its blocker's branch precisely while the
    // blocker sits `in-review`, so an agent still working when the user
    // merges the blocker is the normal case, not an edge case. Re-examining
    // the run the moment it goes terminal is what stops it being stranded on
    // a branch that no longer exists.
    ctx.orchestrator.onRunTerminal((meta) => {
      this.pendingStaleRuns.push(meta.id);
      this.trimIfIdle(meta);
      this.kick();
    });
    this.hydrate();
    // Seed the same check for every run this process inherited. The
    // pending-restack backlog above is in-memory, so a crash between a
    // blocker's merge and the drain would otherwise lose the restack with no
    // trace; re-deriving the need from durable RunMeta (the dependent's own
    // baseBranch/stackParents versus its blocker's persisted reviewedAt)
    // makes boot the recovery path instead.
    for (const meta of ctx.orchestrator.list()) {
      this.pendingStaleRuns.push(meta.id);
    }
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
  //     user to re-enqueue. Re-enqueueing is only actually safe here because
  //     the downstream steps are themselves idempotent against a half-done
  //     prior attempt — merge()'s local-review path is a no-op the second
  //     time via review()/mergeRun's hasChanges skip, and its PR path either
  //     force-pushes again harmlessly or hits `gh pr merge`'s "already
  //     merged" error — not because `reviewedAt` being unset is on its own
  //     proof that nothing landed.
  //   - A `queued`/`waiting-blockers` entry never got touched — reload it as
  //     `queued` (nextEligible() re-derives waiting-blockers on the first
  //     pump) — but only if it still points at a run that's terminal and
  //     unreviewed per the orchestrator's live registry, and isn't a
  //     duplicate of an entry this same hydrate() pass already reloaded (the
  //     persisted file is untrusted input — a bug or a manual edit could
  //     have written the same runId twice). A run that was reviewed,
  //     discarded, or vanished entirely while the daemon was down is dropped
  //     to failed history instead of kept around forever.
  private hydrate(): void {
    const persisted = this.loadPersistedFile();
    // Re-cap on the way in, so a file written before reasons were bounded
    // shrinks on the next boot instead of carrying its old weight forever.
    // The real one that prompted this was 898 KB, 810 KB of it three reasons.
    for (const entry of [...persisted.entries, ...persisted.history]) {
      if (entry.reason !== undefined) {
        entry.reason = truncateReason(entry.reason);
      }
    }
    this.history.push(...persisted.history);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);

    const runsById = new Map(
      this.ctx.orchestrator.list().map((meta) => [meta.id, meta])
    );
    for (const entry of persisted.entries) {
      // A mid-flight entry means the previous process died partway through
      // process() for it. Retrying is safe for exactly the reason the old
      // "re-enqueue to retry" advice gave: the downstream steps are idempotent
      // against a half-done prior attempt — merge()'s local path is a no-op the
      // second time via review()/mergeRun's hasChanges skip, and its PR path
      // either force-pushes again harmlessly or hits `gh pr merge`'s "already
      // merged". So retry automatically instead of making a human notice.
      //
      // Bounded, though: auto-requeue plus a reproducible hang is an infinite
      // loop (die mid-verify, boot, requeue, wedge again). The verify timeout
      // catches most of that, but not the daemon being killed rather than the
      // command overrunning — this cap is that backstop.
      if (MID_FLIGHT_STATES.has(entry.state)) {
        const attempts = (entry.attempts ?? 0) + 1;
        if (attempts > MAX_INTERRUPTED_ATTEMPTS) {
          this.fileStaleEntry(
            entry,
            `abandoned after ${MAX_INTERRUPTED_ATTEMPTS} interrupted attempts — check verifyCommand`
          );
          continue;
        }
        entry.attempts = attempts;
        this.setEntryState(entry, 'queued');
        delete entry.reason;
        this.entries.push(entry);
        continue;
      }
      if (this.entries.some((e) => e.runId === entry.runId)) {
        this.fileStaleEntry(
          entry,
          `duplicate entry for run in persisted merge queue state: ${entry.runId}`
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
      this.setEntryState(entry, 'queued');
      // Any held reason came from the previous process's view of a checkout
      // that may since have been cleaned up — drop it so a reloaded entry
      // doesn't display a stale "blocked because X" that no longer applies.
      // The first pump re-derives it from the live environment.
      delete entry.reason;
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
    this.setEntryState(entry, 'failed');
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

  /**
   * Re-runs the pump against the CURRENT environment — the retry seam for
   * entries held in 'blocked-environment'.
   *
   * Those blockers live in the user's main checkout (an uncommitted file, a
   * staged index, the wrong branch), so nothing this daemon observes tells it
   * when they clear: unlike `waiting-blockers`, which resolves through a run
   * being reviewed and is already covered by the onRunReviewed hook, a `git
   * commit` in a terminal produces no event here. This is what the API calls
   * so the app can say "retry now" once the user has cleaned up, without them
   * having to remove and re-enqueue the entry.
   */
  recheck(): void {
    this.kick();
  }

  // So a blocked entry no longer needs a human to POST /recheck. Single-flight.
  private armBlockedRetry(): void {
    clearTimeout(this.blockedRetryTimer);
    this.blockedRetryTimer = setTimeout(
      () => this.kick(),
      this.blockedRetryDelayMs
    );
  }

  // Nothing left to retry once the queue is fully empty.
  private clearBlockedRetry(): void {
    clearTimeout(this.blockedRetryTimer);
    this.blockedRetryTimer = undefined;
  }

  // Shared eligibility rules for enqueue()/enqueueStack(): a run must be in
  // a terminal state, not yet reviewed, and not already sitting in this
  // queue (active or pending). Split into a reason-returning helper and a
  // boolean wrapper so the two call sites can react differently to an
  // ineligible run — enqueue() throws with the specific reason (it's acting
  // on a single run the caller explicitly asked for), while enqueueStack()
  // just skips a member that fails any check (skipping is the expected,
  // normal outcome for most of a stack — only an all-skipped call is an
  // error there). Neither call site duplicates these checks anymore.
  private whyNotEnqueueable(meta: RunMeta): string | null {
    if (!TERMINAL_RUN_STATES.has(meta.state)) {
      return `run is not in a terminal state: ${meta.id} (state: ${meta.state})`;
    }
    if (meta.reviewedAt !== undefined) {
      return `run has already been reviewed: ${meta.id}`;
    }
    if (this.entries.some((e) => e.runId === meta.id)) {
      return `run is already in the merge queue: ${meta.id}`;
    }
    // No other admission check looks at findings, so without this "merge all
    // ready" would ship work a human ruled unshippable.
    return this.ctx.orchestrator.blockedFindingReason(meta.taskId);
  }

  private isEnqueueable(meta: RunMeta): boolean {
    return this.whyNotEnqueueable(meta) === null;
  }

  // Shared entry shape for enqueue()/enqueueReady() — one place both build
  // the queued entry so they can't drift apart.
  private buildEntry(meta: RunMeta): MergeQueueEntry {
    const now = new Date().toISOString();
    return {
      runId: meta.id,
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      state: 'queued',
      enqueuedAt: now,
      stateSince: now,
    };
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
    const reason = this.whyNotEnqueueable(meta);
    if (reason !== null) {
      throw new OrchestratorConflictError(reason);
    }

    const entry = this.buildEntry(meta);
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
    // includeArchived: an archived blocker/dependent is still a real stack
    // member for ordering purposes — see enqueueReady's identical rationale.
    const tasks = this.ctx.cache.query({ includeArchived: true });
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
      if (!this.isEnqueueable(meta)) continue;

      const entry = this.buildEntry(meta);
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

  // POST /api/merge-queue/ready. Enqueues every eligible run across the whole
  // registry in one shot: runs that share a stack are grouped and ordered via
  // `computeStack` exactly as enqueueStack does (blockers before dependents),
  // runs outside any stack keep orchestrator.list()'s own order. Ineligible
  // runs are skipped silently — an empty result is a valid "nothing was
  // ready" outcome here, not an error like enqueueStack's all-skipped 409.
  enqueueReady(): MergeQueueEntry[] {
    // includeArchived: archivedAt is orthogonal to status/mergeability, and
    // query()'s default (board-view) filter would otherwise drop an archived
    // task's run here and starve computeStack of it as a stack member.
    const tasks = this.ctx.cache.query({ includeArchived: true });
    // Same guard enqueueStack applies: skip only a CONFIRMED done/cancelled
    // task; an unresolved id falls through as eligible, same as there.
    const byId = new Map(tasks.map((t) => [t.meta.id, t]));
    const eligible = this.ctx.orchestrator.list().filter((m) => {
      if (!this.isEnqueueable(m)) return false;
      const task = byId.get(m.taskId);
      return task === undefined || !isDone(task);
    });
    // list() is most-recent-first, so the first eligible run seen per taskId
    // is that task's latest — same convention enqueueStack relies on.
    const eligibleByTaskId = new Map<string, RunMeta>();
    for (const meta of eligible) {
      if (!eligibleByTaskId.has(meta.taskId)) {
        eligibleByTaskId.set(meta.taskId, meta);
      }
    }

    const ordered: RunMeta[] = [];
    const placed = new Set<string>();
    for (const meta of eligible) {
      if (placed.has(meta.taskId)) continue;
      const stack = computeStack(tasks, meta.taskId);
      const order = stack !== null ? stack.order : [meta.taskId];
      for (const id of order) {
        if (placed.has(id)) continue;
        const stackMeta = eligibleByTaskId.get(id);
        if (stackMeta === undefined) continue;
        ordered.push(stackMeta);
        placed.add(id);
      }
    }

    const enqueued = ordered.map((meta) => this.buildEntry(meta));
    this.entries.push(...enqueued);
    if (enqueued.length > 0) this.broadcast();
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
    // Removing the entry a blocked-retry timer was armed for must not leave
    // that timer ticking against an empty queue — kick() re-runs pump(),
    // whose empty-queue branch clears it (and processes anything this
    // removal just unblocked, for free).
    this.kick();
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
      // Set once a drain-push has been attempted for the CURRENT empty
      // streak, so a push that keeps failing retries on the NEXT
      // externally-kicked pump() call (lastDrainPushFailed persists across
      // calls) rather than hot-looping forever inside this one. An entry
      // arriving during the awaited push (see the `next !== null` branch
      // below) clears it, since that entry's own eventual merge is a fresh
      // idle transition worth its own report.
      let idlePushAttempted = false;
      for (;;) {
        // Before anything is picked up: bring every dependent of a
        // just-merged blocker back onto its new base. A dependent whose
        // blocker landed is exactly the entry nextEligible() is about to
        // consider, and it is unmergeable until this has run.
        await this.drainRestacks();
        const next = this.nextEligible();
        if (next === null) {
          // Only once the queue is truly empty (not merely "nothing eligible
          // right now" — an entry can still be sitting in waiting-blockers) is
          // this actually a drain worth pushing/reporting on.
          if (this.entries.length === 0) this.clearBlockedRetry();
          if (this.entries.length === 0 && !idlePushAttempted) {
            const snapshot = this.captureDrainSnapshot();
            if (snapshot !== null) {
              idlePushAttempted = true;
              await this.pushOnDrain(snapshot);
              // `pumping` stays true for this whole call, so an enqueue()
              // landing while the push above was in flight had its own kick()
              // dropped (the pumping guard at the top of this function makes
              // it a no-op) — looping back here, rather than returning, is
              // what actually picks that entry up instead of stranding it at
              // 'queued' with nothing left to nudge it.
              continue;
            }
          }
          return;
        }
        idlePushAttempted = false;
        this.active = next;
        const outcome = await this.process(next);
        this.active = null;
        // An environmental blocker is a property of the one main checkout, so
        // every remaining entry would hit exactly the same wall. Stop the
        // sweep instead of grinding through the queue marking each one
        // blocked in turn (and re-running `git status` per entry to do it).
        if (outcome === 'blocked') {
          this.armBlockedRetry();
          return;
        }
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
    // includeArchived: an archived blocker must still count as an unmet
    // dependency here, or an archived-but-undone task would silently drop
    // its dependent out of waiting-blockers and let it merge early.
    const byId = new Map(
      this.ctx.cache
        .query({ includeArchived: true })
        .map((task) => [task.meta.id, task])
    );
    // Looked up once per pass, same rationale as the task map above: a
    // per-entry registry scan would be O(entries * runs) every pump tick.
    const runsById = new Map(
      this.ctx.orchestrator.list().map((run) => [run.id, run])
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
      // Two independent reasons this isn't a plain `unmet ? … : 'queued'`.
      //
      // A run whose base was discarded is broken, not merely waiting on a
      // blocker. Discarding a blocker resets ITS OWN task to 'todo' (never
      // 'done'), and that blocker's task id is exactly what stacked dispatch
      // put in this dependent's `blockedBy` — so `unmet` would be true forever
      // and the entry would sit at 'waiting-blockers' with no way out and no
      // reason ever shown. Treating it as eligible regardless of `unmet` lets
      // it reach process(), which already checks `baseDiscarded` and fails it
      // fast with a reason. This does NOT loosen the blockedBy gate for
      // anything else: every other entry's `unmet` classification is unchanged.
      //
      // A 'blocked-environment' entry then keeps that state rather than being
      // reset to 'queued': process() re-derives it from the live checkout, and
      // flipping it to 'queued' first would make the UI flicker between
      // "queued" and "blocked" on every pump while the user still has an
      // uncommitted file sitting there. It stays eligible either way, so a
      // baseDiscarded entry still reaches process() through this branch.
      const baseDiscarded = runsById.get(entry.runId)?.baseDiscarded === true;
      const nextState: MergeQueueEntryState =
        unmet && !baseDiscarded
          ? 'waiting-blockers'
          : entry.state === 'blocked-environment'
            ? 'blocked-environment'
            : 'queued';
      if (entry.state !== nextState) {
        this.setEntryState(entry, nextState);
        changed = true;
      }
      if ((!unmet || baseDiscarded) && eligible === null) eligible = entry;
    }
    if (changed) this.broadcast();
    return eligible;
  }

  // Runs one entry through rebase -> verify -> merge. Returns 'blocked' when
  // the main checkout itself stopped the merge (see MergeEnvironmentError):
  // that's transient and global, so the entry is HELD in line with its reason
  // rather than filed to history, and pump() stops the current sweep because
  // no other entry could get past the same checkout either.
  private async process(entry: MergeQueueEntry): Promise<'done' | 'blocked'> {
    const meta = this.ctx.orchestrator.list().find((r) => r.id === entry.runId);
    // The run may have been reviewed or vanished (e.g. discarded directly,
    // bypassing the queue) while this entry was waiting its turn — fail it
    // cleanly rather than trying to act on a run that no longer needs it.
    if (meta === undefined) {
      entry.reason = `run no longer exists: ${entry.runId}`;
      this.finish(entry, 'failed');
      return 'done';
    }
    if (meta.reviewedAt !== undefined) {
      entry.reason = 'run was already reviewed outside the merge queue';
      this.finish(entry, 'failed');
      return 'done';
    }
    // A discarded run's dependents are flagged (Orchestrator.review's discard
    // branch), never auto-repaired — only a human can decide whether this
    // work still makes sense once the base it was built on is gone. Merging
    // it as-is would land content on top of code that was just rejected.
    if (meta.baseDiscarded === true) {
      entry.reason =
        'the run this one was stacked on was discarded — rebase it onto a valid base before merging';
      this.finish(entry, 'failed');
      // 'done' (not 'blocked'): this entry is finished with — filed to failed
      // history for a human to act on. 'blocked' is reserved for a transient
      // main-checkout problem that would stop every other entry too, and this
      // one is specific to this run's own base.
      return 'done';
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
      this.finish(entry, 'merged', meta.baseBranch);
      return 'done';
    } catch (err) {
      // Capped here as well as in commandErrorText: not every throw on this
      // path comes from a command, and `reason` is persisted and broadcast.
      entry.reason = truncateReason((err as Error).message);
      if (err instanceof MergeEnvironmentError) {
        this.setEntryState(entry, 'blocked-environment');
        this.persist();
        this.broadcast();
        return 'blocked';
      }
      this.finish(entry, 'failed');
      return 'done';
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
  //
  // That descendant rewriting is exactly why the jj path is skipped while any
  // run on a DESCENDANT branch is still LIVE — see hasLiveDescendants for what
  // jj does to such a worktree, and why re-attaching it is not an option.
  private async rebase(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    this.setEntryState(entry, 'rebasing');
    this.broadcast();
    const cwd = meta.worktreePath;
    // Say what is actually wrong. Spawning git with a cwd that no longer
    // exists makes posix_spawn return ENOENT, and Bun surfaces that as
    // "no such file or directory, posix_spawn 'git'" — which reads as a
    // missing git binary and sent a real debugging session down that path.
    // The worktree should not be able to disappear from under a queued entry
    // any more (see the claim registered in the constructor), but a directory
    // removed outside the app still has to report itself honestly.
    if (!existsSync(cwd)) {
      throw new Error(
        `worktree is gone: ${cwd} — the branch ${meta.branch} still exists, so re-dispatch the task or discard this run`
      );
    }

    const liveDescendants = await this.hasLiveDescendants(meta.branch);
    if (!liveDescendants && (await this.jj.isColocated())) {
      // The jj rebase runs in the project root and moves `refs/heads/<branch>`
      // out from under this run's own worktree, which has that branch checked
      // out. Measured (jj 0.43.0): the worktree is left DETACHED at the
      // pre-rebase commit with a clean `git status`. verify() runs in that same
      // worktree and merge() squashes the rebased branch, so without the resync
      // below the queue would verify one tree and merge a different one. The
      // resync hard-resets, so uncommitted TRACKED changes are refused outright
      // rather than silently wiped — exactly the case the plain-git path below
      // refuses too, since `git rebase` will not run over them either.
      // Untracked files are not counted, for the same reason: `git rebase`
      // tolerates them (measured), so failing this entry over one would make
      // the jj path refuse merges the git path completes.
      if (this.ctx.orchestrator.runWorktreeIsDirty(meta.id)) {
        throw new Error(
          'worktree has uncommitted changes; commit or discard them before merging'
        );
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
      const jjTarget =
        meta.prUrl !== undefined
          ? `origin/${meta.baseBranch}`
          : meta.baseBranch;
      await this.jj.restack(meta.branch, await this.jjRevision(jjTarget));
      this.ctx.orchestrator.resyncRunWorktree(meta.id);
      return;
    }
    if (liveDescendants) {
      // Rare and consequential enough to be worth a durable line rather than
      // only a comment — §4.6 asks for the chosen path to be recorded.
      this.ctx.orchestrator.appendRunTaskActivity(
        meta.id,
        `merge queue: run ${meta.id} rebased with plain git rather than jj — a run stacked above this branch is still live, and a jj rewrite would detach its worktree`
      );
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
  // Undocumented, flagged in review: a failed verify intentionally leaves
  // the worktree rebased rather than rolling the rebase back — process()'s
  // catch only files the entry to failed history, it never un-rebases. This
  // is retry-friendly (re-enqueueing the same run resumes from an already
  // up-to-date base instead of redoing the rebase), but it does mean the
  // worktree sits mid-way — rebased onto the latest base, not yet
  // verified/merged — until the next enqueue attempt touches it again.
  private async verify(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    const config = loadConfig(this.ctx.rootDir);
    // Named steps when the project configured them, otherwise the single command as one step.
    // Collapsing both onto the same shape is what lets everything downstream — the entry's
    // per-step record, the UI, the failure message — stop caring which form the project uses.
    const steps =
      config.verifySteps !== undefined && config.verifySteps.length > 0
        ? config.verifySteps
        : config.verifyCommand !== undefined
          ? [{ name: 'verify', command: config.verifyCommand }]
          : [];
    if (steps.length === 0) return;
    this.setEntryState(entry, 'verifying');
    // Seeded up front so a client sees the whole pipeline as pending from the first render,
    // rather than steps popping into existence one at a time as they start.
    entry.steps = steps.map((s) => ({ name: s.name, status: 'pending' }));
    this.broadcast();
    // Bounded because the queue is strictly serial: a verify that never returns
    // holds up every entry behind it, and from the outside a wedged step and a
    // slow one look identical. Read fresh from config here, exactly like
    // `verifyCommand` itself, so raising the ceiling takes effect on the next
    // entry without a daemon restart.
    const timeoutSec = config.orchestrator.verifyTimeoutSec;
    entry.output = '';
    for (const [i, step] of steps.entries()) {
      const record = entry.steps[i];
      if (record !== undefined) {
        record.status = 'running';
        this.broadcast();
      }
      const startedAt = Date.now();
      await this.runVerifyStep(entry, meta, step, timeoutSec, i);
      if (record !== undefined) record.ms = Date.now() - startedAt;
    }
    entry.steps.forEach((r) => {
      if (r.status === 'running') r.status = 'passed';
    });
    this.broadcast();
  }

  /** One verify step. Throws on failure, which stops the pipeline — a typecheck failure makes
   * running the tests pointless, and the first real error is the one worth reporting. */
  private async runVerifyStep(
    entry: MergeQueueEntry,
    meta: RunMeta,
    step: { name: string; command: string },
    timeoutSec: number,
    index: number
  ): Promise<void> {
    const record = entry.steps?.[index];
    const result = await this.run(
      meta.worktreePath,
      ['bash', '-lc', step.command],
      {
        timeoutMs: timeoutSec * 1000,
        // Each chunk goes out as its own event and is appended to a bounded tail
        // on the entry. The event is the increment (mirroring `run.log`); the
        // tail is what a client that connects mid-verify or refreshes can read.
        // Deliberately NOT calling broadcast() per chunk — that persists and
        // ships a full snapshot, which at output volume would be pathological.
        onOutput: (chunk: string) => {
          entry.output = `${entry.output ?? ''}${chunk}`.slice(
            -VERIFY_OUTPUT_TAIL_BYTES
          );
          this.ctx.events.broadcast({
            type: 'merge-queue.log',
            runId: entry.runId,
            chunk,
          });
        },
      }
    );
    if (!result.ok) {
      if (record !== undefined) record.status = 'failed';
      // Naming the step is the whole point of configuring them: "verify failed" tells you to go
      // read a log, "typecheck failed" tells you what broke.
      if (/timed out/i.test(result.stderr)) {
        throw new Error(
          `${step.name} timed out after ${timeoutSec}s — raise orchestrator.verifyTimeoutSec or narrow the step`
        );
      }
      throw new Error(`${step.name} failed: ${commandErrorText(result)}`);
    }
    if (record !== undefined) record.status = 'passed';
  }

  // The terminal step: a local run goes through the orchestrator's own
  // squash-merge review path (whatever it throws — a dirty main checkout,
  // a real conflict — propagates up to process()'s catch, failing the entry
  // cleanly); a PR run force-pushes the just-rebased branch, squash-merges
  // the PR via `gh`, and records the merge on the run via
  // markRunMergedViaPr (mirroring what PrManager's own poller does once it
  // sees a PR merged).
  private async merge(entry: MergeQueueEntry, meta: RunMeta): Promise<void> {
    // Re-checked because a finding can be adjudicated while the entry waits,
    // and the PR path below never reaches review()'s own gate.
    const blocked = this.ctx.orchestrator.blockedFindingReason(meta.taskId);
    if (blocked !== null) throw new Error(blocked);
    this.setEntryState(entry, 'merging');
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

  // Works through both restack backlogs — blockers that just merged, and runs
  // that just became safe to touch — one item at a time. Never throws:
  // restacking is repair work that runs *after* a merge already succeeded, so
  // a failure here must not undo or fail that merge. restackRun records the
  // damage on the affected run; anything unexpected above that is logged and
  // stepped over.
  private async drainRestacks(): Promise<void> {
    for (;;) {
      const merged = this.pendingRestacks.shift();
      if (merged !== undefined) {
        try {
          await this.restackDependents(merged);
        } catch (err) {
          console.error(
            `dispatchd: failed to restack dependents of ${merged.id}: ${(err as Error).message}`
          );
        }
        continue;
      }
      if (this.pendingStaleRuns.length === 0) return;
      // Drained as one batch against a SINGLE registry snapshot. Boot seeds
      // every run at once, so re-listing per id would allocate a fresh list
      // for each one before any cheap filter got to reject it. Deduped
      // because a run can be both seeded at construction and pushed by its
      // own terminal hook, and replaying a restack against a snapshot taken
      // before the first one would rebase it a second time.
      const batch = [
        ...new Set(
          this.pendingStaleRuns.splice(0, this.pendingStaleRuns.length)
        ),
      ];
      const runs = this.ctx.orchestrator.list();
      for (const staleRunId of batch) {
        try {
          await this.restackStaleRun(staleRunId, runs);
        } catch (err) {
          console.error(
            `dispatchd: failed to restack ${staleRunId}: ${(err as Error).message}`
          );
        }
      }
    }
  }

  /**
   * Every run stacked on `merged`'s branch, now that that branch has landed
   * and been deleted. Runs still LIVE are deliberately not touched here — an
   * agent owns that worktree — they are picked up by restackStaleRun() the
   * moment they go terminal instead.
   */
  private async restackDependents(merged: RunMeta): Promise<void> {
    const dependents = this.ctx.orchestrator
      .list()
      .filter(
        (r) =>
          r.stackParents?.includes(merged.branch) === true &&
          this.isRestackCandidate(r)
      );
    for (const dependent of dependents) {
      await this.restackRun(dependent, merged);
    }
  }

  /**
   * The other entry point: `runId` just reached a terminal state (or this
   * process just booted), so check whether the branch it was stacked on has
   * been merged away in the meantime and bring it back onto the new base if
   * so.
   */
  private async restackStaleRun(runId: string, runs: RunMeta[]): Promise<void> {
    const run = runs.find((r) => r.id === runId);
    if (run === undefined || !this.isRestackCandidate(run)) return;
    const parent = this.mergedStackParentOf(run, runs);
    if (parent !== null) {
      await this.restackRun(run, parent);
      return;
    }
    // The mirror case, and the reason it is handled here rather than only in
    // Orchestrator.review: a blocker can be DISCARDED while this run's agent
    // is still working, and a live run is deliberately never flagged mid-flight
    // (an error chip on a healthy run is worse than a late one). Nothing else
    // would ever come back to it, so the sweep that catches "your blocker
    // merged" catches "your blocker was thrown away" too.
    const discarded = this.discardedStackParentOf(run, runs);
    if (discarded === null) return;
    this.flagDependent(
      run,
      `the run this one was stacked on (${discarded.id}) was discarded — rebase onto a valid base before merging`
    );
  }

  // A blocker `run` was stacked on that a human discarded. Same shape as
  // mergedStackParentOf below, opposite review action.
  private discardedStackParentOf(
    run: RunMeta,
    runs: RunMeta[]
  ): RunMeta | null {
    for (const branch of run.stackParents ?? []) {
      const parent = runs.find((r) => r.branch === branch);
      if (parent?.reviewAction === 'discard') return parent;
    }
    return null;
  }

  // A run is restackable at all only while NOTHING is live in its worktree
  // (never rewrite a working copy an agent is using), it is still unreviewed
  // (a merged/discarded run has no worktree left), and it is not already
  // flagged — `baseDiscarded` means a human has been asked to look at it, and
  // re-flagging it on every subsequent merge and every reboot would just be
  // noise.
  //
  // The liveness question is deliberately asked of the WORKTREE, not of this
  // run's own state: request-changes starts a new run in the same worktree on
  // the same branch, so a terminal run can sit next to a live one that owns
  // the directory. Testing `run.state` alone would let a restack hard-reset
  // that directory out from under a working agent.
  private isRestackCandidate(run: RunMeta): boolean {
    return (
      run.reviewedAt === undefined &&
      run.baseDiscarded !== true &&
      !this.ctx.orchestrator.worktreeIsBusy(run.id)
    );
  }

  /**
   * Whether any run that is still LIVE sits on a branch that would be rewritten
   * by rewriting `branch` — i.e. a branch descended from it, at ANY depth, plus
   * `branch` itself.
   *
   * This is the gate on jj. jj's whole value here is that rewriting a commit
   * automatically rewrites its descendants and moves their bookmarks — but a
   * descendant branch checked out in a git worktree is left DETACHED at its
   * old commit by that rewrite, with a clean `git status` (measured, jj
   * 0.43.0). Nothing downstream notices: the run's state has not changed, the
   * worktree is not dirty, and the restack paths correctly skip it as live.
   * Its agent then keeps committing onto a detached HEAD, and every one of
   * those commits is silently dropped when the branch is later squash-merged.
   *
   * Re-attaching the descendant is not an option — that means `git checkout`
   * plus `git reset --hard` in a directory an agent is writing to. So the jj
   * path is simply not taken while a live descendant exists: `git rebase` never
   * touches descendants, and the explicit post-merge restack (restackRun)
   * brings them across afterwards anyway.
   *
   * The question is put to GIT, not to recorded `stackParents`. `stackParents`
   * names only a run's IMMEDIATE blockers, and stacks are not two levels deep
   * by nature: with A blocking B blocking C, C is branched off B's branch and
   * records only B — yet C's branch is a git descendant of A's, and
   * `jj rebase -b <A>` rewrites it. A membership test on `stackParents` misses
   * that entirely, which is the whole shape stacked dispatch exists to serve.
   * `git branch --contains` returns every branch reachable-from-descendant in
   * one call, at any depth, and does not depend on metadata being complete —
   * which, as the request-changes bug showed, it can fail to be.
   *
   * Fails CLOSED: a git error (an unresolvable ref) is answered "yes, there may
   * be one", because being wrong in that direction costs a slower rebase while
   * being wrong the other way silently destroys an agent's work.
   */
  private async hasLiveDescendants(branch: string): Promise<boolean> {
    const liveBranches = new Set(
      this.ctx.orchestrator
        .list()
        .filter((r) => !TERMINAL_RUN_STATES.has(r.state))
        .map((r) => r.branch)
    );
    // No live run anywhere is the overwhelmingly common case, and it needs no
    // git call at all — this keeps the ordinary merge path exactly as cheap as
    // it was.
    if (liveBranches.size === 0) return false;
    const contains = await this.run(this.ctx.rootDir, [
      'git',
      'branch',
      '--contains',
      branch,
      '--format=%(refname:short)',
    ]);
    if (!contains.ok) return true;
    for (const line of contains.stdout.split('\n')) {
      if (liveBranches.has(line.trim())) return true;
    }
    return false;
  }

  /**
   * A git ref, resolved to a plain commit id for use as a jj revision.
   *
   * jj does not understand git's remote-tracking ref names: measured on jj
   * 0.43.0, `jj rebase -b feat -d origin/main` fails with ``Revision
   * `origin/main` doesn't exist`` (jj spells that bookmark `main@origin`, and
   * reads `origin/main` only as a local bookmark of that literal name). Every
   * PR-backed rebase and every restack after a PR-merged blocker targets
   * exactly that shape, so each one threw and either failed the entry forever
   * or stuck a permanent `baseDiscarded` flag on the dependent.
   *
   * Resolving through git first sidesteps jj's naming entirely — a commit id
   * is always a valid jj revision (measured: `jj rebase -b feat -d <sha>`
   * rebases as expected) — and works identically for local branch names.
   */
  private async jjRevision(ref: string): Promise<string> {
    const result = await this.run(this.ctx.rootDir, [
      'git',
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
    ]);
    const sha = result.stdout.trim();
    if (!result.ok || sha.length === 0) {
      throw new Error(`unable to resolve ${ref}: ${commandErrorText(result)}`);
    }
    return sha;
  }

  /**
   * A blocker `run` was stacked on that has since been merged away, or null
   * when nothing about this run's base has moved.
   *
   * BOTH stacked shapes have to be recognised here, because the caller's
   * response differs but every one of them still needs a response:
   *
   * - One unmerged blocker: `baseBranch` IS that blocker's branch, and
   *   restackRun moves the run onto the blocker's own base.
   * - Two or more: `baseBranch` is a jj merge-base bookmark
   *   (`dispatch/stack-base-<task>`) that is not any blocker's branch, while
   *   `stackParents` lists them all. Such a run can NOT be restacked onto any
   *   single blocker's base, but it must still be flagged the moment the first
   *   blocker lands — restackRun does that, and returning the merged blocker
   *   here is the only thing that gets it there. Keying solely on `baseBranch`
   *   made this whole shape invisible to the terminal/boot path, so a
   *   multi-parent dependent that was still live when its blocker merged was
   *   left neither restacked nor flagged.
   *
   * Scanning `stackParents` (rather than `baseBranch` alone) is safe for the
   * jj-unavailable fallback, which is the other way a task with 2+ blockers
   * can be dispatched: resolveBase records NO stackParents at all there, so
   * that path can never match and is never falsely flagged.
   *
   * Detection is deliberately the parent RUN's review marker rather than
   * "the branch ref no longer resolves": a missing ref also means "a human
   * deleted a branch" or "this daemon has not reconciled yet", whereas
   * `reviewedAt` means exactly "this landed" and is persisted on the parent's
   * own transcript, which is what lets the boot sweep re-derive it.
   */
  private mergedStackParentOf(run: RunMeta, runs: RunMeta[]): RunMeta | null {
    const parents = run.stackParents ?? [];
    if (parents.length === 0) return null;
    // The run's own base is checked first so the single-blocker shape always
    // resolves to the parent that actually determines its new base.
    const ordered = parents.includes(run.baseBranch)
      ? [run.baseBranch, ...parents.filter((b) => b !== run.baseBranch)]
      : parents;
    for (const branch of ordered) {
      const parent = runs.find((r) => r.branch === branch);
      if (parent === undefined || parent.reviewedAt === undefined) continue;
      if (parent.reviewAction === 'merge' || parent.reviewAction === 'pr') {
        return parent;
      }
    }
    return null;
  }

  /**
   * Brings one dependent back onto the base its merged blocker landed on.
   * Two paths, same outcome:
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
   * dependent's).
   *
   * Everything that cannot be done safely is FLAGGED rather than guessed at,
   * and a flagged dependent never fails the entry that just merged
   * successfully — the merge really did land; it is the dependent that needs
   * a human.
   */
  private async restackRun(dependent: RunMeta, parent: RunMeta): Promise<void> {
    // A dependent whose base is NOT the merged branch itself was branched off
    // a multi-parent jj merge base built over several unmerged blockers.
    // Moving it onto this one blocker's base would silently drop the others'
    // work, and leaving it silently alone is worse still: its remaining
    // blockers merge one by one and it is never repaired, until the queue
    // fails it with an opaque "merge target is main, expected
    // dispatch/stack-base-…". That case needs a rebuilt merge base, which is
    // not something this method can do, so it is flagged for a human.
    if (dependent.baseBranch !== parent.branch) {
      this.flagDependent(
        dependent,
        `cannot restack automatically: this run was branched off the multi-parent base ${dependent.baseBranch}, which spans several unmerged blockers — rebuild it or re-dispatch now that ${parent.branch} has merged`
      );
      return;
    }
    const newBase = parent.baseBranch;
    const stackBase = dependent.stackBaseCommit;
    if (stackBase === undefined) {
      // Nothing records where this run's own commits begin, so neither path
      // can name the range to replay.
      this.flagDependent(
        dependent,
        'cannot restack: no stackBaseCommit recorded for this run'
      );
      return;
    }
    // Both steps below would throw away uncommitted TRACKED changes — the
    // rebase refuses to run over them, the resync hard-resets past them.
    // Every normal finish path auto-commits, so this is only ever true for a
    // cancelled run whose worktree was deliberately left as-is; refuse rather
    // than destroy it. (Untracked files are handled one level down, by
    // resyncToBranch's own collision check — see WorktreeManager.isDirty.)
    if (this.ctx.orchestrator.runWorktreeIsDirty(dependent.id)) {
      this.flagDependent(
        dependent,
        'cannot restack: worktree has uncommitted changes — commit or discard them, then re-dispatch'
      );
      return;
    }

    // Same jj gate rebase() applies, for the same reason: `jj rebase -s` also
    // rewrites the descendants of the commits it moves, so a live run anywhere
    // above THIS dependent in the stack would be silently detached.
    const viaJj =
      !(await this.hasLiveDescendants(dependent.branch)) &&
      (await this.jj.isColocated());
    // Backup first — this is the undo path if the restack goes wrong. It is
    // NOT the rebase boundary: that is stackBaseCommit, recorded at dispatch.
    // Backing up the tip and then replaying from it would make the replay
    // range empty and silently rebase nothing.
    this.ctx.orchestrator.backupRunBranch(dependent.id);
    try {
      // A blocker merged through a PR landed its content on the REMOTE base
      // and nothing was merged locally (markRunMergedViaPr is explicit about
      // this), so the local base branch can be arbitrarily far behind.
      // Replaying onto it would drop the blocker's files from the dependent
      // entirely. Fetch and target `origin/<base>`, exactly as rebase() below
      // already does for a PR run's own rebase.
      const target =
        parent.reviewAction === 'pr'
          ? `origin/${await this.fetchBase(newBase)}`
          : newBase;
      if (viaJj) {
        // Resolved to a commit id: jj cannot parse `origin/<base>` at all —
        // see jjRevision.
        await this.jj.restackOnto(
          dependent.branch,
          stackBase,
          await this.jjRevision(target)
        );
      } else {
        this.ctx.orchestrator.rebaseRunOnto(dependent.id, target, stackBase);
      }
      this.ctx.orchestrator.resyncRunWorktree(dependent.id);
      // Recorded as the plain branch name, never `origin/<base>`: this is the
      // branch mergeRun() compares the main checkout against, and the one
      // rebase() re-prefixes with `origin/` for a PR run.
      this.ctx.orchestrator.repointRunBase(dependent.id, newBase);
      this.noteRestack(
        dependent,
        parent,
        `restacked onto ${target} after blocker run ${parent.id} merged (via ${viaJj ? 'jj' : 'git rebase --onto'})`
      );
    } catch (err) {
      this.flagDependent(
        dependent,
        `restack onto ${newBase} failed: ${(err as Error).message}`
      );
    }
  }

  // Fetches a base branch from origin so `origin/<base>` is current, and
  // returns the branch name for the caller to compose with. Throws on
  // failure, which restackRun turns into a flag on the dependent.
  private async fetchBase(baseBranch: string): Promise<string> {
    const fetch = await this.run(this.ctx.rootDir, [
      'git',
      'fetch',
      'origin',
      baseBranch,
    ]);
    if (!fetch.ok) {
      throw new Error(`git fetch failed: ${commandErrorText(fetch)}`);
    }
    return baseBranch;
  }

  // Flags a dependent for human attention and says so on its own task's
  // Activity, so the record is visible on the run the user is looking at and
  // not only in the run's error field.
  private flagDependent(dependent: RunMeta, reason: string): void {
    this.ctx.orchestrator.flagRunRestackFailure(dependent.id, reason);
    this.ctx.orchestrator.appendRunTaskActivity(
      dependent.id,
      `merge queue: run ${dependent.id} ${reason}`
    );
  }

  // Records a successful restack on BOTH tasks involved: the dependent's own
  // (the run whose history was just rewritten) and the merged blocker's (the
  // action that caused it).
  private noteRestack(dependent: RunMeta, parent: RunMeta, text: string): void {
    this.ctx.orchestrator.appendRunTaskActivity(
      dependent.id,
      `merge queue: run ${dependent.id} ${text}`
    );
    if (parent.taskId !== dependent.taskId) {
      this.ctx.orchestrator.appendRunTaskActivity(
        parent.id,
        `merge queue: dependent run ${dependent.id} ${text}`
      );
    }
  }

  // Removes `entry` from the live queue, stamps it terminal, and files it
  // into history (most-recent-first, capped at HISTORY_LIMIT) — the one
  // place both `merged` and `failed` outcomes converge. `mergedBaseBranch` is
  // supplied only for a 'merged' outcome, and is what feeds pushOnDrain's
  // eventual `git push origin <base>` once the queue empties out.
  /**
   * Reclaims a just-finished run's reinstallable dependency directories, keeping
   * its checkout so the run stays reviewable (see trimWorktree).
   *
   * Measured motivation: 641MB of a 648MB worktree is `node_modules`, and a run
   * that is terminal-but-unreviewed holds that indefinitely — those are exactly
   * the worktrees that accumulate, because a reviewed run's worktree is removed
   * outright by `review()`.
   *
   * It costs nothing at merge time: `verifyCommand` runs an install on every
   * entry anyway, so a later merge would have reinstalled regardless.
   *
   * Skipped while the run has an entry in this queue. Trimming mid-rebase or
   * mid-verify would delete dependencies out from under a running test suite,
   * and the queue is about to need them.
   */
  private trimIfIdle(meta: RunMeta): void {
    if (this.entries.some((e) => e.runId === meta.id)) return;
    if (this.active?.runId === meta.id) return;
    try {
      const { removed } = trimWorktree(meta.worktreePath);
      if (removed.length > 0) {
        console.error(
          `dispatchd: trimmed ${removed.length} reinstallable director${removed.length === 1 ? 'y' : 'ies'} from ${meta.id}'s worktree`
        );
      }
    } catch (err) {
      // Reclaiming disk is opportunistic — never let it break the run lifecycle.
      console.error(
        `dispatchd: failed to trim worktree for ${meta.id}: ${(err as Error).message}`
      );
    }
  }

  // The one place an entry's state is written, so `stateSince` cannot drift out
  // of sync with it. Every transition site routes through here rather than
  // assigning `entry.state` directly — a forgotten stamp would silently make an
  // entry look like it had been in its current state since whenever it last
  // happened to be updated, which is worse than showing no elapsed time at all.
  private setEntryState(
    entry: MergeQueueEntry,
    state: MergeQueueEntryState
  ): void {
    entry.state = state;
    entry.stateSince = new Date().toISOString();
  }

  private finish(
    entry: MergeQueueEntry,
    state: 'merged' | 'failed',
    mergedBaseBranch?: string
  ): void {
    const idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
    this.setEntryState(entry, state);
    entry.finishedAt = new Date().toISOString();
    this.history.unshift(entry);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    if (state === 'merged' && mergedBaseBranch !== undefined) {
      this.mergedSinceIdle += 1;
      this.lastMergeBase = mergedBaseBranch;
    }
    this.broadcast();
  }

  // Snapshots mergedSinceIdle and clears it, synchronously and in one step,
  // before pushOnDrain ever awaits anything — a merge that lands later (once
  // pump()'s loop continues and picks up a newly-enqueued entry) must
  // increment a FRESH counter and earn its own later report, not be folded
  // into (or lost from) the drain this snapshot is about to describe.
  // `lastMergeBase` is read but deliberately NOT cleared here: a failed push
  // keeps it around so the retry (see `lastDrainPushFailed`) targets the same
  // branch. Returns null when there is nothing to report at all: no merge
  // since the last drain and no push owed a retry.
  private captureDrainSnapshot(): {
    merged: number;
    base: string | undefined;
  } | null {
    if (this.mergedSinceIdle === 0 && !this.lastDrainPushFailed) return null;
    const merged = this.mergedSinceIdle;
    this.mergedSinceIdle = 0;
    return { merged, base: this.lastMergeBase };
  }

  // Fires once the pump loop finds the queue fully drained: pushes origin's
  // copy of whatever base branch was just merged into, so a human never has
  // to remember to `git push` after every merge queue run. Acts strictly on
  // the snapshot captureDrainSnapshot took (never re-reads the live counters
  // itself), so it can't double-report or drop a merge that lands while its
  // own `await` is in flight. Never throws — a push failure is reported via
  // the `queue.drained` event and `lastDrainPushFailed`, not an exception,
  // since this runs after every entry that needed it has already finished
  // successfully.
  private async pushOnDrain(snapshot: {
    merged: number;
    base: string | undefined;
  }): Promise<void> {
    const { merged, base } = snapshot;
    if (!this.ctx.orchestrator.hasOriginRemote() || base === undefined) {
      this.lastDrainPushFailed = false;
      this.ctx.events.broadcast({
        type: 'queue.drained',
        merged,
        pushed: false,
      });
      return;
    }

    const push = await this.run(this.ctx.rootDir, [
      'git',
      'push',
      'origin',
      base,
    ]);
    if (push.ok) {
      this.lastDrainPushFailed = false;
      this.ctx.orchestrator.reconcileArchives();
      this.ctx.events.broadcast({
        type: 'queue.drained',
        merged,
        pushed: true,
      });
    } else {
      this.lastDrainPushFailed = true;
      this.ctx.events.broadcast({
        type: 'queue.drained',
        merged,
        pushed: false,
        pushError: commandErrorText(push),
      });
    }
  }

  // Whether this project has a configured git remote — the gate refreshRemote
  // applies internally, and the same check startAutoRefresh uses to decide
  // whether the 60s timer is worth creating at all.
  hasOriginRemote(): boolean {
    return this.ctx.orchestrator.hasOriginRemote();
  }

  // Keeps `origin/<base>` current independently of a drain (a teammate can
  // push to the shared base without ever touching this queue) and reconciles
  // archives off the freshly-fetched refs. Called on startAutoRefresh's tick.
  async refreshRemote(): Promise<void> {
    if (!this.hasOriginRemote()) return;
    try {
      await this.fetchBase(this.ctx.orchestrator.defaultBaseBranch());
    } catch (err) {
      if (!this.fetchFailureLogged) {
        this.fetchFailureLogged = true;
        console.error(
          `dispatchd: merge queue refreshRemote fetch failed: ${(err as Error).message}`
        );
      }
      return;
    }
    this.ctx.orchestrator.reconcileArchives();
  }

  // Starts the 60s remote-refresh tick, mirroring PrManager.startPolling() —
  // a separate opt-in call rather than something the constructor does itself,
  // so every test that builds a MergeQueue directly (most of this file's
  // suite) doesn't also have to remember to stop a real interval it never
  // asked for. Production wires this up once, from startServer.
  startAutoRefresh(intervalMs = 60_000): void {
    if (!this.hasOriginRemote()) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refreshRemote();
    }, intervalMs);
  }

  // Tears down every timer this queue can own — the blocked-retry self-check
  // and the auto-refresh tick — mirroring PrManager.stopPolling().
  stop(): void {
    this.clearBlockedRetry();
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
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
