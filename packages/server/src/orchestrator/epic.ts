import {
  claimConflictsWithWrites,
  dispatchableTasks,
  loadConfig,
  schedulableBatch,
} from '@dispatch/core';
import type { ActorContext, TaskDoc, TaskStorePort } from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { FindingStorePort } from '../findings.js';
import {
  deriveChildPhase,
  deriveSpend,
  deriveWaves,
  summarizeWaves,
  unsatisfiedBlockersOf,
} from './epicPhase.js';
import type { EpicProgressChild, EpicSpend, EpicWave } from './epicPhase.js';
import type { FixLoopState } from './fixLoop.js';
import type { Orchestrator } from './orchestrator.js';
import { epicSessionsPath, runsDir } from './paths.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

type EpicSessionState = 'active' | 'paused' | 'stopped' | 'complete';
export type EpicPauseReason = 'human' | 'budget' | 'runs' | 'fill-failed';

// One epic's dispatch session. Persisted write-through to
// `epicSessionsPath` (see persist()/hydrate()) so a dispatchd restart re-arms
// an active session instead of forgetting it; the fill chain, retry counter
// and boot arm flag are memory-only and reset on boot. Spend and run counts
// are never stored — they are derived from the run registry on every read.
interface EpicSessionRecord {
  /** Execute + review + verify slots — liveCount is kind-agnostic by design. */
  concurrency: number;
  executor: string;
  state: EpicSessionState;
  /** Set while paused, cleared on resume. */
  pausedReason?: EpicPauseReason;
  /** The message behind a `fill-failed` pause. */
  pausedDetail?: string;
  /** `null` = no spend ceiling. */
  maxSpendUsd: number | null;
  /** `null` = no run ceiling. */
  maxRuns: number | null;
  /** Fixed for the session's life — pause/resume never reset it. */
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The human who started the session; its auto-fill runs act for them. */
  startedBy?: string;
  /** Critical-risk children already noted as held on the epic's Activity,
   *  so each is announced once per session rather than on every fill. */
  heldCritical: Set<string>;
}

// The on-disk shape of one record: the Set becomes an array.
type PersistedSessionRecord = Omit<EpicSessionRecord, 'heldCritical'> & {
  heldCritical: string[];
};

interface EpicSessionsSnapshot {
  version: 1;
  sessions: Record<string, PersistedSessionRecord>;
}

export interface EpicSession {
  epicId: string;
  concurrency: number;
  executor: string;
  state: EpicSessionState;
  pausedReason?: EpicPauseReason;
  pausedDetail?: string;
  maxSpendUsd: number | null;
  maxRuns: number | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The human who started the session; its auto-fill runs act for them. */
  startedBy?: string;
  /** `state === 'active'` — kept for `formatEpicProgress` and `--watch`. */
  active: boolean;
}

export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  session: EpicSession | null;
  /** For the session's runs, or for every child run when there is none. */
  spend: EpicSpend;
  children: EpicProgressChild[];
  waves: EpicWave[];
  liveRuns: RunMeta[];
}

/** The ceilings and concurrency a session may be started or resumed with. */
export interface EpicSessionOptions {
  concurrency?: number;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
}

/** The narrow view of FixLoop the engine reads phases from — bound late
 *  because FixLoop is constructed after the engine (see bindFixLoop). */
export interface EpicFixLoopPort {
  get(taskId: string): FixLoopState | null;
  list(): FixLoopState[];
}

export interface EpicEngineContext {
  rootDir: string;
  store: TaskStorePort;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  // Open findings per child for progress(); optional so tests may omit it.
  findingStore?: Pick<FindingStorePort, 'openFor'>;
  // Test-injection seam for the self-retry delay below, so a test can watch a
  // stalled fill recover without sleeping the production window.
  fillRetryDelayMs?: number;
  // How long a hydrated session waits after boot before it fills again
  // (see resumeOnBoot). Tests shrink it.
  resumeDelayMs?: number;
  // The `epic.changed` debounce window; `0` broadcasts synchronously so a
  // test can assert right after the call.
  eventDebounceMs?: number;
  // Optional, same "tests may omit it" contract as OrchestratorContext's own
  // field — appendEpicActivity() below falls back to an unattributed
  // Activity line when it's absent.
  actorContext?: ActorContext;
}

// How long a fill that failed outright waits before retrying itself, and how
// many consecutive retries one epic gets before it pauses on its own.
const DEFAULT_FILL_RETRY_DELAY_MS = 15_000;
const MAX_FILL_RETRIES = 3;
// How long a session hydrated at boot stays unarmed. Longer than the
// orchestrator's AUTO_RESUME_QUIET_MS so its quiet-tree auto-resume claims
// crash victims first, instead of this engine forking fresh runs for them.
const BOOT_RESUME_DELAY_MS = 45_000;
const DEFAULT_EVENT_DEBOUNCE_MS = 250;
const SESSION_STATES: ReadonlySet<string> = new Set([
  'active',
  'paused',
  'stopped',
  'complete',
]);

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

// `(concurrency 8, ceiling $60.00, max 20 runs)` — the parenthetical the
// start/resume Activity lines share.
function describeSession(session: EpicSessionRecord): string {
  const parts = [`concurrency ${session.concurrency}`];
  if (session.maxSpendUsd !== null) {
    parts.push(`ceiling ${formatUsd(session.maxSpendUsd)}`);
  }
  if (session.maxRuns !== null) parts.push(`max ${session.maxRuns} runs`);
  return `(${parts.join(', ')})`;
}

/**
 * The epic-level parallel dispatch engine (spec §5 Dispatch step 6): starting
 * an epic dispatches its ready children up to a concurrency cap, and every
 * time a child run reaches a terminal state, newly-unblocked siblings
 * auto-dispatch to fill any freed slot — all driven by Orchestrator's
 * `onRunTerminal` push hook, never a poll. A session pauses itself at its
 * spend or run ceiling (or after a fill keeps failing) and waits for
 * `resume()`; `stop()` and a pause only halt *new* dispatches — runs already
 * live keep running to their own completion.
 *
 * The session record is persisted to `epicSessionsPath` (write-through, like
 * MergeQueue) so a restart re-arms it through resumeOnBoot(); the durable
 * trail a human reads is still the epic Activity lines this class appends
 * via TaskStore, same as every other orchestrator lifecycle event.
 */
export class EpicEngine {
  private readonly sessions = new Map<string, EpicSessionRecord>();
  // Sessions allowed to fill. A hydrated `active` session stays out of this
  // set until resumeOnBoot()'s timer adds it; start()/resume() add it directly.
  private readonly armed = new Set<string>();
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
  private readonly resumeDelayMs: number;
  private readonly eventDebounceMs: number;
  // Pending trailing `epic.changed` broadcast per epic (see emitChanged).
  private readonly changedTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // resumeOnBoot()'s pending re-arm timers, so shutdown() can cancel them.
  private readonly resumeTimers = new Set<ReturnType<typeof setTimeout>>();
  // Set by shutdown(): no fill starts and nothing persists after it.
  private closed = false;
  private fixLoop: EpicFixLoopPort | null = null;

  constructor(private readonly ctx: EpicEngineContext) {
    this.fillRetryDelayMs = ctx.fillRetryDelayMs ?? DEFAULT_FILL_RETRY_DELAY_MS;
    this.resumeDelayMs = ctx.resumeDelayMs ?? BOOT_RESUME_DELAY_MS;
    this.eventDebounceMs = ctx.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS;
    this.hydrate();
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

  // Whether any epic is still dispatching work. A paused, stopped or complete
  // epic waits on a human and can wait just as well in a restarted daemon.
  hasActiveSession(): boolean {
    for (const record of this.sessions.values()) {
      if (record.state === 'active') return true;
    }
    return false;
  }

  // FixLoop is constructed after this engine (its terminal hook must run
  // after the review runner's), so the phase reads bind to it late. Until
  // bound, no child ever reads as fixing/reviewing-by-loop/capped.
  bindFixLoop(port: EpicFixLoopPort): void {
    this.fixLoop = port;
  }

  // POST /api/epics/:id/dispatch. `concurrency` defaults to the project's
  // `orchestrator.epicConcurrency` config; `executor` defaults to the project's
  // but tests override it (see the Global Constraints note on honoring a
  // body override) to dispatch through FakeExecutor instead.
  // Async only because the initial fillQueue is awaited: start() must still
  // be able to tear its own session down when that very first dispatch
  // throws (see the catch below), which a fire-and-forget `void` could not.
  async start(
    epicId: string,
    opts: EpicSessionOptions & { executor?: string; startedBy?: string } = {}
  ): Promise<EpicSession> {
    const epic = this.requireEpic(epicId);
    const existing = this.sessions.get(epicId);
    if (existing?.state === 'active') {
      throw new OrchestratorConflictError(
        `epic already has an active dispatch session: ${epicId}`
      );
    }
    if (existing?.state === 'paused') {
      throw new OrchestratorConflictError(
        `epic already has a dispatch session (paused) — resume or stop it first: ${epicId}`
      );
    }
    // C2(a): validate everything BEFORE creating any session state — a
    // bogus name or ceiling must 400 cleanly with nothing left behind for a
    // subsequent, correctly-specified retry to trip over.
    const executor =
      opts.executor ?? this.ctx.orchestrator.defaultExecutorName();
    const knownExecutors = this.ctx.orchestrator.registeredExecutorNames();
    if (!knownExecutors.includes(executor)) {
      throw new OrchestratorClientError(
        `invalid executor: ${executor} (expected ${knownExecutors.join('|')})`
      );
    }
    const orchestratorConfig = loadConfig(this.ctx.rootDir).orchestrator;
    const concurrency = this.validateConcurrency(
      opts.concurrency ?? orchestratorConfig.epicConcurrency,
      orchestratorConfig.maxConcurrency
    );
    const maxSpendUsd = validateMaxSpend(opts.maxSpendUsd ?? null);
    const maxRuns = validateMaxRuns(opts.maxRuns ?? null);
    const now = new Date().toISOString();
    const session: EpicSessionRecord = {
      concurrency,
      executor,
      state: 'active',
      maxSpendUsd,
      maxRuns,
      startedAt: now,
      updatedAt: now,
      ...(opts.startedBy === undefined ? {} : { startedBy: opts.startedBy }),
      heldCritical: new Set(),
    };
    this.sessions.set(epicId, session);
    this.armed.add(epicId);
    this.persist();
    try {
      this.appendEpicActivity(
        epicId,
        `epic dispatch started ${describeSession(session)}`
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
      this.armed.delete(epicId);
      this.persist();
      throw err;
    }
    this.emitChanged(epicId);
    return this.publicSession(epic.meta.id, session);
  }

  // POST /api/epics/:id/pause. Halts new dispatches until resume(); anything
  // already live keeps running.
  pause(epicId: string): EpicSession {
    this.requireEpic(epicId);
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active') {
      throw new OrchestratorConflictError(
        `epic has no active dispatch session: ${epicId}`
      );
    }
    session.state = 'paused';
    session.pausedReason = 'human';
    delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch paused by you (live runs continue)'
    );
    this.persist();
    this.emitChanged(epicId);
    return this.publicSession(epicId, session);
  }

  // POST /api/epics/:id/resume. The mid-session throttle and "raise the
  // ceiling" verb: overrides are validated like start()'s, then the session
  // fills again. `startedAt` is untouched, so spend keeps counting the runs
  // already made.
  async resume(
    epicId: string,
    opts: EpicSessionOptions = {}
  ): Promise<EpicSession> {
    this.requireEpic(epicId);
    const session = this.sessions.get(epicId);
    if (session?.state !== 'paused') {
      throw new OrchestratorConflictError(
        `epic has no paused dispatch session: ${epicId}`
      );
    }
    const concurrency =
      opts.concurrency === undefined
        ? session.concurrency
        : this.validateConcurrency(
            opts.concurrency,
            loadConfig(this.ctx.rootDir).orchestrator.maxConcurrency
          );
    const maxSpendUsd =
      opts.maxSpendUsd === undefined
        ? session.maxSpendUsd
        : validateMaxSpend(opts.maxSpendUsd);
    const maxRuns =
      opts.maxRuns === undefined
        ? session.maxRuns
        : validateMaxRuns(opts.maxRuns);
    session.concurrency = concurrency;
    session.maxSpendUsd = maxSpendUsd;
    session.maxRuns = maxRuns;
    session.state = 'active';
    delete session.pausedReason;
    delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.armed.add(epicId);
    this.appendEpicActivity(
      epicId,
      `epic dispatch resumed ${describeSession(session)}`
    );
    this.persist();
    try {
      await this.enqueueFill(epicId);
    } catch (err) {
      // Back to paused with the reason on the record, so the card shows why
      // and a second resume can try again; the caller still sees the error.
      session.state = 'paused';
      session.pausedReason = 'fill-failed';
      session.pausedDetail = (err as Error).message;
      session.updatedAt = new Date().toISOString();
      this.persist();
      this.emitChanged(epicId);
      throw err;
    }
    this.emitChanged(epicId);
    return this.publicSession(epicId, session);
  }

  // POST /api/epics/:id/stop. Halts new dispatches only — anything already
  // live keeps running to its own natural finish/fail/cancel.
  stop(epicId: string): EpicSession {
    this.requireEpic(epicId);
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active' && session?.state !== 'paused') {
      throw new OrchestratorConflictError(
        `epic has no active dispatch session: ${epicId}`
      );
    }
    session.state = 'stopped';
    delete session.pausedReason;
    delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.armed.delete(epicId);
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch stopped (new dispatches halted; live runs continue)'
    );
    this.persist();
    this.emitChanged(epicId);
    return this.publicSession(epicId, session);
  }

  // GET /api/epics/:id/progress: every child with its server-derived phase
  // and wave, the session, its spend, and the live runs dispatched against
  // any child.
  progress(epicId: string): EpicProgress {
    this.requireEpic(epicId);
    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    // Newest first, so the first run seen per task is its latest.
    const childRuns = this.ctx.orchestrator
      .list()
      .filter((r) => childIds.has(r.taskId));
    const liveRuns = childRuns.filter((r) => !TERMINAL_RUN_STATES.has(r.state));
    const liveByTask = new Map<string, RunMeta>();
    const latestByTask = new Map<string, RunMeta>();
    for (const run of childRuns) {
      if (!latestByTask.has(run.taskId)) latestByTask.set(run.taskId, run);
      if (!liveByTask.has(run.taskId) && !TERMINAL_RUN_STATES.has(run.state)) {
        liveByTask.set(run.taskId, run);
      }
    }
    const dispatchable = new Set(
      dispatchableTasks(this.ctx.cache.query({ includeArchived: true })).map(
        (t) => t.meta.id
      )
    );
    const waves = deriveWaves(children);
    const session = this.sessions.get(epicId);
    const progressChildren: EpicProgressChild[] = children.map((task) => {
      const id = task.meta.id;
      const latestRun = latestByTask.get(id) ?? null;
      const derived = deriveChildPhase({
        task,
        liveRun: liveByTask.get(id) ?? null,
        latestRun,
        fixLoop: this.fixLoop?.get(id) ?? null,
        blockedReason: this.ctx.orchestrator.blockedFindingReason(id),
        unsatisfiedBlockers: unsatisfiedBlockersOf(task, (blockerId) =>
          this.ctx.store.get(blockerId)
        ),
        dispatchable: dispatchable.has(id),
      });
      return {
        id,
        title: task.meta.title,
        status: task.meta.status,
        phase: derived.phase,
        wave: waves.get(id) ?? 1,
        ...(derived.reason !== undefined ? { reason: derived.reason } : {}),
        ...(derived.runId !== undefined ? { runId: derived.runId } : {}),
        ...(latestRun?.costUsd !== undefined
          ? { costUsd: latestRun.costUsd }
          : {}),
        openFindings: this.ctx.findingStore?.openFor(id).length ?? 0,
      };
    });
    return {
      epicId,
      active: session?.state === 'active',
      concurrency: session?.concurrency,
      session:
        session === undefined ? null : this.publicSession(epicId, session),
      spend: deriveSpend(
        childRuns,
        session?.startedAt ?? null,
        loadConfig(this.ctx.rootDir).orchestrator.runCostEstimateUsd,
        {
          maxSpendUsd: session?.maxSpendUsd ?? null,
          maxRuns: session?.maxRuns ?? null,
        }
      ),
      children: progressChildren,
      waves: summarizeWaves(progressChildren),
      liveRuns,
    };
  }

  // GET /api/epics/progress: progress() for every non-archived epic (the
  // desktop's `data.epics` set), in id order — one request for every surface
  // that shows a milestone.
  progressAll(): EpicProgress[] {
    return this.ctx.cache
      .query({ kind: 'epic' })
      .map((epic) => epic.meta.id)
      .sort()
      .map((epicId) => this.progress(epicId));
  }

  // Re-arms every session hydrated as `active`, each after `resumeDelayMs`
  // so the orchestrator's quiet-tree auto-resume claims the previous
  // process's crash victims first. Paused/stopped/complete records are left
  // alone — a budget pause survives a restart, preserving the human's
  // decision. Returns how many were scheduled, for the boot log.
  resumeOnBoot(): number {
    let count = 0;
    for (const [epicId, session] of this.sessions) {
      if (session.state !== 'active' || this.armed.has(epicId)) continue;
      count++;
      const timer = setTimeout(() => {
        this.resumeTimers.delete(timer);
        const current = this.sessions.get(epicId);
        if (current === undefined || current.state !== 'active') return;
        this.armed.add(epicId);
        this.scheduleFill(epicId);
      }, this.resumeDelayMs);
      timer.unref?.();
      this.resumeTimers.add(timer);
    }
    return count;
  }

  // Cancels every pending timer and turns later fills and writes into no-ops.
  // runsDir resolves DISPATCH_HOME at write time, so a retry firing after its
  // owner is gone would otherwise write into whatever home is current by then.
  shutdown(): void {
    this.closed = true;
    for (const timer of this.resumeTimers) clearTimeout(timer);
    for (const timer of this.fillRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.changedTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    this.fillRetryTimers.clear();
    this.fillRetryAttempts.clear();
    this.changedTimers.clear();
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

  // Only `active` sessions react: a paused one must not flip to complete
  // underneath the human who paused it, and stopped/complete are final.
  private reactAcrossSessions(): void {
    for (const [epicId, session] of [...this.sessions]) {
      if (session.state !== 'active') continue;
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
    if (this.closed) return;
    void this.enqueueFill(epicId).then(
      () => this.fillRetryAttempts.delete(epicId),
      (err: unknown) => {
        // A fill already in flight at shutdown must not arm a new retry.
        if (this.closed) return;
        const message = (err as Error).message;
        this.recordFillFailure(epicId, message);
        this.armFillRetry(epicId, message);
      }
    );
  }

  // A fill that dispatched nothing fires no lifecycle hook, so nothing else
  // would ever retry it. Bounded: a failure that repeats is not transient,
  // so past the budget the session pauses with the message instead of going
  // silently idle.
  private armFillRetry(epicId: string, message: string): void {
    const attempts = (this.fillRetryAttempts.get(epicId) ?? 0) + 1;
    if (attempts > MAX_FILL_RETRIES) {
      this.pauseFor(epicId, 'fill-failed', message);
      return;
    }
    this.fillRetryAttempts.set(epicId, attempts);
    clearTimeout(this.fillRetryTimers.get(epicId));
    const timer = setTimeout(() => {
      this.fillRetryTimers.delete(epicId);
      const session = this.sessions.get(epicId);
      if (session?.state !== 'active') return;
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
  private recordFillFailure(epicId: string, message: string): void {
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

  // An automatic pause: a ceiling reached, or a fill that kept failing. The
  // Activity line carries the numbers, and `epic.paused` carries them to
  // every client so the toast needs no fetch. Never used for a human's
  // pause — that one has no event.
  private pauseFor(
    epicId: string,
    reason: Exclude<EpicPauseReason, 'human'>,
    detail?: string
  ): void {
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active') return;
    session.state = 'paused';
    session.pausedReason = reason;
    if (detail !== undefined) session.pausedDetail = detail;
    else delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.clearFillRetry(epicId);
    const spend = this.sessionSpend(epicId, session);
    const why =
      reason === 'budget'
        ? `spend ceiling reached (${formatUsd(spend.settledUsd)} settled + ~${formatUsd(spend.estimatedLiveUsd)} in flight of ${formatUsd(spend.maxSpendUsd ?? 0)})`
        : reason === 'runs'
          ? `run ceiling reached (${spend.runsStarted}/${spend.maxRuns ?? 0} runs)`
          : `auto-dispatch kept failing: ${detail ?? ''}`;
    try {
      this.appendEpicActivity(epicId, `epic dispatch paused — ${why}`, 'none');
    } catch {
      // A pause reached from a failing fill may fail to append for the same
      // reason the fill did; the record and the event still carry it.
    }
    this.persist();
    this.emitChanged(epicId);
    this.ctx.events.broadcast({
      type: 'epic.paused',
      epicId,
      reason,
      settledUsd: spend.settledUsd,
      estimatedLiveUsd: spend.estimatedLiveUsd,
      maxSpendUsd: spend.maxSpendUsd,
      runsStarted: spend.runsStarted,
      maxRuns: spend.maxRuns,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  // The session's spend: every run on a child created since `startedAt`,
  // charged at the current config estimate while live.
  private sessionSpend(
    epicId: string,
    session: EpicSessionRecord,
    estimate = loadConfig(this.ctx.rootDir).orchestrator.runCostEstimateUsd
  ): EpicSpend {
    const childIds = new Set(this.childrenOf(epicId).map((c) => c.meta.id));
    return deriveSpend(
      this.ctx.orchestrator.list().filter((r) => childIds.has(r.taskId)),
      session.startedAt,
      estimate,
      { maxSpendUsd: session.maxSpendUsd, maxRuns: session.maxRuns }
    );
  }

  // Dispatches ready children via schedulableBatch (conflicts.ts): concurrency
  // cap, then the run and spend ceilings, no two overlapping `writes` in one
  // batch. Readiness runs over the FULL task set first, since dispatchableTasks
  // treats a blocker it wasn't given as satisfied — a blocker in another epic,
  // or in none, must still count. The ceilings are only consulted once there
  // is something to gate, so a session never pauses with nothing to dispatch.
  private async fillQueue(epicId: string): Promise<void> {
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active' || !this.armed.has(epicId)) return;

    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveCount = this.ctx.orchestrator
      .list()
      .filter(
        (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
      ).length;
    let slots = session.concurrency - liveCount;
    if (slots <= 0) return;

    // childIds now includes archived children (see childrenOf); dispatchability
    // must exclude them explicitly rather than rely on childrenOf's filtering.
    const ready = dispatchableTasks(
      this.ctx.cache.query({ includeArchived: true })
    ).filter(
      (t) =>
        childIds.has(t.meta.id) &&
        t.meta.archivedAt === undefined &&
        !this.holdCritical(session, epicId, t)
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
    if (clearOfLiveRuns.length === 0) return;

    if (session.maxRuns !== null || session.maxSpendUsd !== null) {
      // Read per pass, like the merge queue's verifyCommand, so a config edit
      // mid-session changes the next gate.
      const estimate = loadConfig(this.ctx.rootDir).orchestrator
        .runCostEstimateUsd;
      const spend = this.sessionSpend(epicId, session, estimate);
      if (session.maxRuns !== null) {
        slots = Math.min(slots, session.maxRuns - spend.runsStarted);
        // No future terminal can free a run, so this pause is final until
        // the human raises the ceiling.
        if (slots <= 0) {
          this.pauseFor(epicId, 'runs');
          return;
        }
      }
      if (session.maxSpendUsd !== null) {
        const allowance = Math.floor(
          (session.maxSpendUsd - spend.settledUsd - spend.estimatedLiveUsd) /
            estimate
        );
        slots = Math.min(slots, allowance);
        if (slots <= 0) {
          // A live run's settle can raise the allowance (its real cost is
          // usually below the estimate), so only pause once nothing is live.
          if (liveCount === 0) this.pauseFor(epicId, 'budget');
          return;
        }
      }
    }

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
          operator: session.startedBy ?? null,
        });
      } catch (err) {
        // A task that already picked up a live run outside this session
        // (raced between the readiness snapshot and here) just gets skipped.
        if (err instanceof OrchestratorConflictError) continue;
        throw err;
      }
    }
    if (batch.length > 0) this.emitChanged(epicId);
  }

  // A critical-risk child (a publish, a release, a repo-settings change) is
  // never auto-dispatched: the autonomy ladder caps such a task at rung 1
  // (core/policy.ts RISK_RUNG_CAPS), and the epic scheduler's own fill is an
  // auto-decision. It waits for a human to dispatch it by hand, and the hold
  // is written to the epic's Activity once so it reads as a decision rather
  // than a child that silently never starts. Returns true when held.
  private holdCritical(
    session: EpicSessionRecord,
    epicId: string,
    task: TaskDoc
  ): boolean {
    if (task.meta.risk !== 'critical') return false;
    if (!session.heldCritical.has(task.meta.id)) {
      session.heldCritical.add(task.meta.id);
      this.persist();
      this.appendEpicActivity(
        epicId,
        `holding ${task.meta.id} for explicit human dispatch — critical-risk work is never auto-dispatched`,
        'none'
      );
    }
    return true;
  }

  // True once none of an epic's children is still pending work: nothing sits
  // at `ready` (unstarted, whether or not it's currently dispatchable) or
  // `working`, no child has a run still live (a review or verify run on a
  // child parked at `review` is still this session's work), and no child's
  // fix loop is mid-round. This deliberately does NOT wait for a human review
  // action (merge/discard/PR) to flip a task all the way to `landed`; the
  // epic's own dispatch work is done once nothing is left running or
  // runnable. A session with only capped loops left stays active — those
  // wait on a ruling, which is the human's queue. An epic with zero children
  // never "completes" on its own (there is nothing to wait on, but also
  // nothing accomplished).
  private isEpicComplete(epicId: string): boolean {
    const children = this.childrenOf(epicId);
    if (children.length === 0) return false;
    if (
      children.some(
        (c) => c.meta.status === 'ready' || c.meta.status === 'working'
      )
    ) {
      return false;
    }
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveRun = this.ctx.orchestrator
      .list()
      .some((r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state));
    if (liveRun) return false;
    const loopInFlight =
      this.fixLoop
        ?.list()
        .some(
          (loop) =>
            childIds.has(loop.taskId) &&
            (loop.state === 'implementing' || loop.state === 'reviewing')
        ) ?? false;
    return !loopInFlight;
  }

  private completeEpic(epicId: string): void {
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active') return;
    const now = new Date().toISOString();
    session.state = 'complete';
    session.completedAt = now;
    session.updatedAt = now;
    this.armed.delete(epicId);
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch session ended — no children left to dispatch',
      'none'
    );
    this.persist();
    this.emitChanged(epicId);
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

  private validateConcurrency(value: number, maxConcurrency: number): number {
    if (!Number.isInteger(value) || value < 1 || value > maxConcurrency) {
      throw new OrchestratorClientError(
        `invalid concurrency: ${String(value)} (expected an integer between 1 and ${maxConcurrency}, the configured orchestrator.maxConcurrency)`
      );
    }
    return value;
  }

  // `actor` credits who caused this epic-level Activity line: omitted
  // defaults to the daemon's human (start()/pause()/resume()/stop() are all
  // only ever reached through the API), while a mechanical line (an
  // auto-fill completing, a ceiling pause, a hook error) passes 'none'
  // explicitly at its own call site.
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

  // The `epic.changed` refetch signal, debounced per epic on a trailing
  // timer so a wave's terminal storm is one refetch. A window of 0 (the test
  // seam) broadcasts synchronously.
  private emitChanged(epicId: string): void {
    if (this.eventDebounceMs === 0) {
      this.ctx.events.broadcast({ type: 'epic.changed', epicId });
      return;
    }
    clearTimeout(this.changedTimers.get(epicId));
    const timer = setTimeout(() => {
      this.changedTimers.delete(epicId);
      this.ctx.events.broadcast({ type: 'epic.changed', epicId });
    }, this.eventDebounceMs);
    timer.unref?.();
    this.changedTimers.set(epicId, timer);
  }

  // Write-through persistence, called on every session transition and held
  // announcement. Non-atomic writeFileSync with a trailing newline, the same
  // convention as MergeQueue.persist(); a crash mid-write is handled by
  // hydrate()'s try/catch on the read side. Best-effort: a failure here must
  // never block the transition that triggered it.
  private persist(): void {
    if (this.closed) return;
    try {
      mkdirSync(runsDir(this.ctx.rootDir), { recursive: true });
      const sessions: Record<string, PersistedSessionRecord> = {};
      for (const [epicId, session] of this.sessions) {
        sessions[epicId] = {
          ...session,
          heldCritical: [...session.heldCritical],
        };
      }
      const snapshot: EpicSessionsSnapshot = { version: 1, sessions };
      writeFileSync(
        epicSessionsPath(this.ctx.rootDir),
        `${JSON.stringify(snapshot)}\n`
      );
    } catch (err) {
      console.error(
        `dispatchd: failed to persist epic sessions: ${(err as Error).message}`
      );
    }
  }

  // Lenient read of the persisted file: a missing or corrupt file starts
  // empty and logs once, and an entry whose state is not one of the four (or
  // is missing the fields a fill needs) is dropped rather than trusted. Every
  // hydrated `active` session starts unarmed — resumeOnBoot() arms it.
  private hydrate(): void {
    const path = epicSessionsPath(this.ctx.rootDir);
    if (!existsSync(path)) return;
    let parsed: Partial<EpicSessionsSnapshot>;
    try {
      parsed = JSON.parse(
        readFileSync(path, 'utf8')
      ) as Partial<EpicSessionsSnapshot>;
    } catch (err) {
      console.error(
        `dispatchd: failed to read epic sessions, starting empty: ${(err as Error).message}`
      );
      return;
    }
    const sessions =
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.sessions !== null &&
      typeof parsed.sessions === 'object'
        ? parsed.sessions
        : {};
    for (const [epicId, raw] of Object.entries(sessions)) {
      const record = raw as Partial<PersistedSessionRecord> | null;
      if (
        record === null ||
        typeof record !== 'object' ||
        typeof record.state !== 'string' ||
        !SESSION_STATES.has(record.state) ||
        !Number.isInteger(record.concurrency) ||
        (record.concurrency as number) < 1 ||
        typeof record.executor !== 'string' ||
        typeof record.startedAt !== 'string'
      ) {
        continue;
      }
      this.sessions.set(epicId, {
        concurrency: record.concurrency as number,
        executor: record.executor,
        state: record.state,
        ...(record.pausedReason !== undefined
          ? { pausedReason: record.pausedReason }
          : {}),
        ...(record.pausedDetail !== undefined
          ? { pausedDetail: record.pausedDetail }
          : {}),
        maxSpendUsd:
          typeof record.maxSpendUsd === 'number' ? record.maxSpendUsd : null,
        maxRuns: typeof record.maxRuns === 'number' ? record.maxRuns : null,
        startedAt: record.startedAt,
        updatedAt:
          typeof record.updatedAt === 'string'
            ? record.updatedAt
            : record.startedAt,
        ...(record.completedAt !== undefined
          ? { completedAt: record.completedAt }
          : {}),
        ...(typeof record.startedBy === 'string'
          ? { startedBy: record.startedBy }
          : {}),
        heldCritical: new Set(
          Array.isArray(record.heldCritical)
            ? record.heldCritical.filter((id) => typeof id === 'string')
            : []
        ),
      });
    }
  }

  private publicSession(
    epicId: string,
    session: EpicSessionRecord
  ): EpicSession {
    return {
      epicId,
      concurrency: session.concurrency,
      executor: session.executor,
      state: session.state,
      ...(session.pausedReason !== undefined
        ? { pausedReason: session.pausedReason }
        : {}),
      ...(session.pausedDetail !== undefined
        ? { pausedDetail: session.pausedDetail }
        : {}),
      maxSpendUsd: session.maxSpendUsd,
      maxRuns: session.maxRuns,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      ...(session.completedAt !== undefined
        ? { completedAt: session.completedAt }
        : {}),
      ...(session.startedBy !== undefined
        ? { startedBy: session.startedBy }
        : {}),
      active: session.state === 'active',
    };
  }
}

function validateMaxSpend(value: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OrchestratorClientError(
      `invalid maxSpendUsd: ${String(value)} (expected a positive number or null)`
    );
  }
  return value;
}

function validateMaxRuns(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new OrchestratorClientError(
      `invalid maxRuns: ${String(value)} (expected an integer >= 1 or null)`
    );
  }
  return value;
}
