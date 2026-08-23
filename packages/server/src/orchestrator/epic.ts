import {
  claimConflictsWithWrites,
  dispatchableTasks,
  loadConfig,
  schedulableBatch,
} from '@dispatch/core';
import type { ActorContext, TaskDoc, TaskStore } from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

// One epic's live dispatch session. Deliberately registry-only — nothing
// here is written to disk beyond the epic Activity lines each transition
// leaves behind — a dispatchd restart simply loses in-flight sessions (any
// children still running keep running; nothing new auto-dispatches for them
// until a fresh `start()` call), the same "machine-local" contract the plan
// gives the epic engine.
interface EpicSessionRecord {
  concurrency: number;
  executor: string;
  active: boolean;
  completedAt?: string;
}

export interface EpicSession {
  epicId: string;
  concurrency: number;
  active: boolean;
  completedAt?: string;
}

interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
}

export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  children: EpicProgressChild[];
  liveRuns: RunMeta[];
}

export interface EpicEngineContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  // Test-injection seam for the self-retry delay below, so a test can watch a
  // stalled fill recover without sleeping the production window.
  fillRetryDelayMs?: number;
  // Optional, same "tests may omit it" contract as OrchestratorContext's own
  // field — appendEpicActivity() below falls back to an unattributed
  // Activity line when it's absent.
  actorContext?: ActorContext;
}

// How long a fill that failed outright waits before retrying itself, and how
// many consecutive retries one epic gets before it stops on its own.
const DEFAULT_FILL_RETRY_DELAY_MS = 15_000;
const MAX_FILL_RETRIES = 3;

/**
 * The epic-level parallel dispatch engine (spec §5 Dispatch step 6): starting
 * an epic dispatches its ready children up to a concurrency cap, and every
 * time a child run reaches a terminal state, newly-unblocked siblings
 * auto-dispatch to fill any freed slot — all driven by Orchestrator's
 * `onRunTerminal` push hook, never a poll. `stop()` only halts *new*
 * dispatches; runs already live keep running to their own completion.
 *
 * State lives entirely in an in-memory Map (machine-local, like PlanManager)
 * — the durable trail is the epic Activity lines this class appends via
 * TaskStore, same as every other orchestrator lifecycle event.
 */
export class EpicEngine {
  private readonly sessions = new Map<string, EpicSessionRecord>();
  // One serialization chain per epic — see scheduleFill() for why fillQueue
  // can no longer simply be called from the run-lifecycle hooks.
  private readonly fillChains = new Map<string, Promise<void>>();
  // Self-retry state per epic: the pending timer and how many consecutive
  // retries it has already spent (see armFillRetry).
  private readonly fillRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly fillRetryAttempts = new Map<string, number>();
  private readonly fillRetryDelayMs: number;

  constructor(private readonly ctx: EpicEngineContext) {
    this.fillRetryDelayMs = ctx.fillRetryDelayMs ?? DEFAULT_FILL_RETRY_DELAY_MS;
    // Two distinct triggers can make an epic's next dispatch decision stale:
    // a run reaching a terminal state (frees a concurrency slot, and — since
    // Orchestrator.handleFinish moves the task to `in-review` before firing
    // terminal hooks — is also the exact moment a blocker becomes
    // dispatch-satisfying; see core's isSatisfiedForDispatch) and a run
    // being reviewed (a discard sends the task back to `todo`, undoing that
    // satisfaction for any dependent not yet dispatched). They are handled
    // by two *distinct* methods below (not funneled into one), because a
    // discard review must NOT trigger the same re-dispatch a merge/PR-merge
    // would (see I3 in onRunReviewed's own doc comment).
    ctx.orchestrator.onRunTerminal((meta) => this.onRunTerminal(meta));
    ctx.orchestrator.onRunReviewed((meta) => this.onRunReviewed(meta));
  }

  // POST /api/epics/:id/dispatch. `concurrency` defaults to the project's
  // `orchestrator.epicConcurrency` config; `executor` defaults to 'claude'
  // but tests override it (see the Global Constraints note on honoring a
  // body override) to dispatch through FakeExecutor instead.
  // Async only because the initial fillQueue is awaited: start() must still
  // be able to tear its own session down when that very first dispatch
  // throws (see the catch below), which a fire-and-forget `void` could not.
  async start(
    epicId: string,
    opts: { concurrency?: number; executor?: string } = {}
  ): Promise<EpicSession> {
    const epic = this.requireEpic(epicId);
    const existing = this.sessions.get(epicId);
    if (existing !== undefined && existing.active) {
      throw new OrchestratorConflictError(
        `epic already has an active dispatch session: ${epicId}`
      );
    }
    // C2(a): validate the executor BEFORE creating any session state — a
    // bogus name must 400 cleanly with nothing left behind for a
    // subsequent, correctly-specified retry to trip over.
    const executor = opts.executor ?? 'claude';
    const knownExecutors = this.ctx.orchestrator.registeredExecutorNames();
    if (!knownExecutors.includes(executor)) {
      throw new OrchestratorClientError(
        `invalid executor: ${executor} (expected ${knownExecutors.join('|')})`
      );
    }
    const concurrency =
      opts.concurrency ??
      loadConfig(this.ctx.rootDir).orchestrator.epicConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new OrchestratorClientError(
        `invalid concurrency: ${String(opts.concurrency)} (expected an integer >= 1)`
      );
    }
    const session: EpicSessionRecord = {
      concurrency,
      executor,
      active: true,
    };
    this.sessions.set(epicId, session);
    try {
      this.appendEpicActivity(
        epicId,
        `epic dispatch started (concurrency ${concurrency})`
      );
      // Chained like every other fill (see enqueueFill) — a run reaching a
      // terminal state *inside* this very dispatch fires the lifecycle hooks
      // synchronously, so a hook-driven fill can otherwise interleave with
      // this one. Rejections still propagate here, which is what keeps the
      // session rollback below working.
      await this.enqueueFill(epicId);
    } catch (err) {
      // C2(a): never leave a wedged session behind a failed initial
      // dispatch — a retry (even with identical args) must start clean,
      // not 409 on "already has an active session" for a session that
      // never actually got off the ground.
      this.sessions.delete(epicId);
      throw err;
    }
    return this.publicSession(epic.meta.id, session);
  }

  // POST /api/epics/:id/stop. Halts new dispatches only — anything already
  // live keeps running to its own natural finish/fail/cancel.
  stop(epicId: string): EpicSession {
    this.requireEpic(epicId);
    const session = this.sessions.get(epicId);
    if (session === undefined || !session.active) {
      throw new OrchestratorConflictError(
        `epic has no active dispatch session: ${epicId}`
      );
    }
    session.active = false;
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch stopped (new dispatches halted; live runs continue)'
    );
    return this.publicSession(epicId, session);
  }

  // GET /api/epics/:id/progress: children grouped by status plus the live
  // runs currently dispatched against any of them.
  progress(epicId: string): EpicProgress {
    this.requireEpic(epicId);
    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveRuns = this.ctx.orchestrator
      .list()
      .filter(
        (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
      );
    const session = this.sessions.get(epicId);
    return {
      epicId,
      active: session?.active ?? false,
      concurrency: session?.concurrency,
      children: children.map((c) => ({
        id: c.meta.id,
        title: c.meta.title,
        status: c.meta.status,
      })),
      liveRuns,
    };
  }

  // Orchestrator.onRunTerminal's subscriber: a run reaching a terminal state
  // frees a concurrency slot (or, for a single-child epic, can complete it
  // outright). C1: this reacts across EVERY active session, not just the
  // one owning the terminated run's own task — a run's terminal state can
  // be exactly what unblocks a *different* epic's child (a cross-epic
  // blocker; see the readiness fix in fillQueue's own doc comment), and the
  // cheapest correct way to notice that is to just re-check every active
  // session on every event rather than trying to compute which sessions
  // could possibly care.
  private onRunTerminal(_meta: RunMeta): void {
    this.reactAcrossSessions();
  }

  // Orchestrator.onRunReviewed's subscriber. I3 (adjudicated): a discarded
  // run's task returns to `todo`, but that must NOT be read as "newly
  // ready" by any active session — discard means a human judged the work
  // wrong, and auto-re-dispatching the identical prompt would just burn
  // budget repeating the same mistake. The task simply stays in the ready
  // queue for a human (or a future session) to explicitly pick up again.
  // Merge/PR-merge (task -> `done`) is no longer the trigger that unblocks a
  // sibling: fillQueue's dispatchableTasks() already counts a blocker as
  // satisfied the moment it reaches `in-review`, which onRunTerminal already
  // reacted to. The non-discard branch here still re-checks readiness
  // (cheap, and a no-op if nothing changed) so nothing is missed if a review
  // action is ever the first signal an active session sees.
  private onRunReviewed(meta: RunMeta): void {
    if (meta.reviewAction === 'discard') return;
    this.reactAcrossSessions();
  }

  private reactAcrossSessions(): void {
    for (const epicId of [...this.sessions.keys()]) {
      if (this.isEpicComplete(epicId)) {
        this.completeEpic(epicId);
      } else {
        this.scheduleFill(epicId);
      }
    }
  }

  /**
   * Appends a fillQueue pass for `epicId` to that epic's serialization chain
   * and returns a promise for THIS pass.
   *
   * Serializing matters now that fillQueue is async — Orchestrator.dispatch
   * awaits base resolution before it registers anything in the run registry,
   * so a fill that is mid-`await` has dispatches in flight that the registry
   * cannot see yet. The run-lifecycle hooks that trigger a fill are
   * synchronous and can fire during another fill's await (including during
   * start()'s own initial fill, which is why that one is chained too). Two
   * overlapping passes would each read the same live-run count and between
   * them hand out more slots than the session's concurrency cap allows.
   * Chaining is what keeps that count honest — EVERY fill must go through
   * here, never `fillQueue` directly.
   *
   * The stored chain link deliberately never rejects, so one failed pass
   * cannot poison every later one; the returned promise does reject, so
   * start() can still roll its session back.
   */
  private enqueueFill(epicId: string): Promise<void> {
    const previous = this.fillChains.get(epicId) ?? Promise.resolve();
    const pass = previous.then(() => this.fillQueue(epicId));
    this.fillChains.set(
      epicId,
      pass.catch(() => {})
    );
    return pass;
  }

  // Fire-and-forget fill for the run-lifecycle hooks, which have no caller
  // left to receive a rejection — an unhandled one would take the daemon
  // down. Failures are recorded rather than propagated, matching
  // invokeHooksSafely's rule for a throwing subscriber.
  private scheduleFill(epicId: string): void {
    void this.enqueueFill(epicId).then(
      () => this.fillRetryAttempts.delete(epicId),
      (err: unknown) => {
        this.recordFillFailure(epicId, err);
        this.armFillRetry(epicId);
      }
    );
  }

  // A fill that dispatched nothing fires no lifecycle hook, so nothing else
  // would ever retry it. Bounded: a failure that repeats is not transient.
  private armFillRetry(epicId: string): void {
    const attempts = (this.fillRetryAttempts.get(epicId) ?? 0) + 1;
    if (attempts > MAX_FILL_RETRIES) return;
    this.fillRetryAttempts.set(epicId, attempts);
    clearTimeout(this.fillRetryTimers.get(epicId));
    const timer = setTimeout(() => {
      this.fillRetryTimers.delete(epicId);
      const session = this.sessions.get(epicId);
      if (session === undefined || !session.active) return;
      this.scheduleFill(epicId);
    }, this.fillRetryDelayMs);
    // Never a reason to keep the daemon (or a test process) alive.
    timer.unref?.();
    this.fillRetryTimers.set(epicId, timer);
  }

  private clearFillRetry(epicId: string): void {
    clearTimeout(this.fillRetryTimers.get(epicId));
    this.fillRetryTimers.delete(epicId);
    this.fillRetryAttempts.delete(epicId);
  }

  // The durable half of that rule: invokeHooksSafely doesn't just log a
  // failed hook, it appends an Activity line, rebuilds the cache and
  // broadcasts, so the failure is visible in the UI rather than only in the
  // daemon's stderr. An auto-dispatch that silently stops filling is exactly
  // the kind of thing a user needs told about, so this mirrors both halves.
  private recordFillFailure(epicId: string, err: unknown): void {
    const message = (err as Error).message;
    console.error(
      `dispatchd: epic dispatch fill failed for ${epicId}: ${message}`
    );
    try {
      this.appendEpicActivity(
        epicId,
        `[hook error] auto-dispatch failed: ${message}`,
        'none'
      );
    } catch {
      // Even the Activity append failing must not propagate — same rule
      // invokeHooksSafely applies to its own bookkeeping.
    }
  }

  // Dispatches ready children via schedulableBatch (conflicts.ts): concurrency
  // cap, no two overlapping `writes` in one batch. Readiness runs over the FULL
  // task set first, since dispatchableTasks treats a blocker it wasn't given as
  // satisfied — a blocker in another epic, or in none, must still count.
  private async fillQueue(epicId: string): Promise<void> {
    const session = this.sessions.get(epicId);
    if (session === undefined || !session.active) return;

    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveCount = this.ctx.orchestrator
      .list()
      .filter(
        (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
      ).length;
    const slots = session.concurrency - liveCount;
    if (slots <= 0) return;

    // childIds now includes archived children (see childrenOf); dispatchability
    // must exclude them explicitly rather than rely on childrenOf's filtering.
    const ready = dispatchableTasks(this.ctx.cache.query()).filter(
      (t) => childIds.has(t.meta.id) && t.meta.archivedAt === undefined
    );
    // A live run's footprint can have grown past its task's declared writes
    // (see Orchestrator.liveClaims) — a newly-ready task must avoid that too.
    const liveClaims = this.ctx.orchestrator.liveClaims().map((c) => c.claims);
    // An undeclared task (`writes: []`) therefore waits on ANY live claim until
    // that run goes terminal — nothing reaps one, so a parked run waits on a human.
    const clearOfLiveRuns = ready.filter(
      (t) =>
        !liveClaims.some((claim) =>
          claimConflictsWithWrites(claim, t.meta.writes)
        )
    );
    const batch = schedulableBatch(
      clearOfLiveRuns.map((t) => ({ id: t.meta.id, writes: t.meta.writes })),
      slots
    );
    for (const taskId of batch) {
      try {
        // The epic scheduler's own auto-fill decided this task was next —
        // no human pressed dispatch for it specifically. Through
        // dispatchOrResume, not dispatch: a task whose last run a restart left
        // recoverable must be picked back up here too, since a fresh run would
        // strand that worktree and cancel the sweep still watching it.
        await this.ctx.orchestrator.dispatchOrResume(taskId, {
          executor: session.executor,
          actor: 'none',
        });
      } catch (err) {
        // A task that already picked up a live run outside this session
        // (raced between the readiness snapshot and here) just gets skipped.
        if (err instanceof OrchestratorConflictError) continue;
        throw err;
      }
    }
  }

  // True once none of an epic's children is still pending work: nothing sits
  // at `todo` (unstarted, whether or not it's currently ready) or
  // `in-progress` (a live run). Every child that ever ran has already
  // reached its own terminal run state by the time onRunTerminal calls this
  // (that's the only thing that calls it) and therefore moved to
  // `in-review`/`done`/`cancelled` — this deliberately does NOT wait for a
  // human review action (merge/discard/PR) to flip a task all the way to
  // `done`; the epic's own dispatch work is done once nothing is left
  // running or runnable. An epic with zero children never "completes" on
  // its own (there is nothing to wait on, but also nothing accomplished).
  private isEpicComplete(epicId: string): boolean {
    const children = this.childrenOf(epicId);
    if (children.length === 0) return false;
    return !children.some(
      (c) => c.meta.status === 'todo' || c.meta.status === 'in-progress'
    );
  }

  private completeEpic(epicId: string): void {
    const session = this.sessions.get(epicId);
    if (session === undefined || session.completedAt !== undefined) return;
    session.completedAt = new Date().toISOString();
    session.active = false;
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch session ended — no children left to dispatch',
      'none'
    );
  }

  // Includes archived children: progress/completeness are historical facts
  // about the epic, and an archived child is done+pushed, not missing.
  private childrenOf(epicId: string): TaskDoc[] {
    return this.ctx.cache
      .query({ parent: epicId, includeArchived: true })
      .filter((t) => t.meta.kind === 'task');
  }

  private requireEpic(epicId: string): TaskDoc {
    const epic = this.ctx.store.get(epicId);
    if (epic === null) {
      throw new OrchestratorNotFoundError(`epic not found: ${epicId}`);
    }
    if (epic.meta.kind !== 'epic') {
      throw new OrchestratorClientError(`not an epic: ${epicId}`);
    }
    return epic;
  }

  // `actor` credits who caused this epic-level Activity line: omitted
  // defaults to the daemon's human (start()/stop() are both only ever
  // reached through the API), while a mechanical line (an auto-fill
  // completing, a hook error) passes 'none' explicitly at its own call site.
  private appendEpicActivity(
    epicId: string,
    text: string,
    actor?: string
  ): void {
    const now = new Date().toISOString();
    this.ctx.store.update(
      epicId,
      {
        appendActivity: `${now} [epic] ${text}`,
        activityActor: actor ?? this.ctx.actorContext?.humanRef,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  private publicSession(
    epicId: string,
    session: EpicSessionRecord
  ): EpicSession {
    return {
      epicId,
      concurrency: session.concurrency,
      active: session.active,
      completedAt: session.completedAt,
    };
  }
}
