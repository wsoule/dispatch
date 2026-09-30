import {
  claimConflictsWithWrites,
  dispatchableTasks,
  fanoutCoverers,
  fanoutHolder,
  fanoutScope,
  fanoutWaitingOn,
  hasStatusRole,
  isContainerKind,
  isUnstartedStatus,
  loadConfig,
  releasesFanoutDependents,
  schedulableBatch,
} from '@dispatch/core';
import type {
  ActorContext,
  FanoutBlocker,
  StatusModel,
  TaskDoc,
  TaskListItem,
  TaskStorePort,
} from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { FindingStorePort } from '../findings.js';
import { statusModelFor } from '../statuses.js';
import {
  deriveChildPhase,
  deriveSpend,
  deriveWaves,
  summarizeWaves,
} from './epicPhase.js';
import type { EpicProgressChild, EpicSpend, EpicWave } from './epicPhase.js';
import type { FixLoopState } from './fixLoop.js';
import type { Orchestrator } from './orchestrator.js';
import { epicSessionsPath, runsDir } from './paths.js';
import type { TaskAuthorship } from './taskAuthorship.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

type EpicSessionState = 'active' | 'paused' | 'stopped' | 'complete';
export type EpicPauseReason = 'human' | 'budget' | 'runs' | 'fill-failed';
/** What a session covers: its container's whole fan-out scope (core's
 *  fanoutScope), or only its direct children — the rule a session persisted
 *  before plan-wide fan-outs was started under, and keeps. */
type EpicSessionScope = 'plan' | 'direct';

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
  /** The `human:` ref that started it: the one person whose assigned tasks
   *  it may pick up. Null on a session persisted before this was recorded,
   *  which works for the daemon's local human. */
  startedBy: string | null;
  /** `direct` on a session persisted without it. */
  scope: EpicSessionScope;
  updatedAt: string;
  completedAt?: string;
  /** The human its auto-fill runs act for; absent when the shared agentToken
   *  started it. */
  operator?: string;
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
  /** Who started it; teammates' tasks are never auto-dispatched for them. */
  startedBy: string | null;
  /** The whole plan, or (a session from before plan-wide fan-outs) its
   *  container's direct children only. */
  scope: EpicSessionScope;
  updatedAt: string;
  completedAt?: string;
  /** The human its auto-fill runs act for; absent when the shared agentToken
   *  started it. */
  operator?: string;
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
  // Who wrote each task; absent, every auto-fill run acts for no one.
  authorship?: TaskAuthorship;
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

// Tasks by parent id, for walking fan-out scopes over one board read.
function childrenIndex<T extends TaskListItem>(
  tasks: readonly T[]
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const task of tasks) {
    const parent = task.meta.parent;
    if (parent === null) continue;
    const bucket = out.get(parent);
    if (bucket === undefined) out.set(parent, [task]);
    else bucket.push(task);
  }
  return out;
}

// Tasks whose work sits on a branch a dependent can stack on: a terminal,
// unreviewed run (the rule Orchestrator.branchForTask picks a base by).
function tasksWithRunBranch(runs: readonly RunMeta[]): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    if (TERMINAL_RUN_STATES.has(run.state) && run.reviewedAt === undefined) {
      out.add(run.taskId);
    }
  }
  return out;
}

// A blocker as a fan-out working for `holder`'s dispatcher sees it.
function blockerView(
  holder: (task: TaskListItem) => string | null,
  withRunBranch: ReadonlySet<string>
): (blocker: TaskListItem) => FanoutBlocker {
  return (blocker) => ({
    held: holder(blocker) !== null,
    hasRunBranch: withRunBranch.has(blocker.meta.id),
  });
}

// What a session's last fill left waiting (see EpicEngine.onTasksChanged).
interface Watched {
  /** Blockers its own unstarted work waits on. */
  waiting: Set<string>;
  /** Its unstarted tasks a teammate holds. */
  held: Set<string>;
}

// Active or paused: a session that still claims its scope.
function isLive(session: EpicSessionRecord): boolean {
  return session.state === 'active' || session.state === 'paused';
}

// One child's reading, shared by every container whose scope holds it (a
// milestone's and its project's): only the wave differs between them.
type ChildReading = Omit<EpicProgressChild, 'wave'>;

// The board as progress() reads it, shared by every epic in one request.
interface ProgressBoard {
  statuses: StatusModel;
  byId: Map<string, TaskListItem>;
  children: Map<string, TaskListItem[]>;
  dispatchable: Set<string>;
  runs: RunMeta[];
  /** Each task's latest run and its live one; `runs` is newest first. */
  latestRun: Map<string, RunMeta>;
  liveRun: Map<string, RunMeta>;
  /** See tasksWithRunBranch. */
  withRunBranch: Set<string>;
  /** Readings by `<dispatcher> <task id>`, filled as containers ask. */
  readings: Map<string, ChildReading>;
  runCostEstimateUsd: number;
}

/**
 * The epic-level parallel dispatch engine (spec §5 Dispatch step 6): starting
 * an epic dispatches its ready children up to a concurrency cap, and every
 * time a child run reaches a terminal state, newly-unblocked siblings
 * auto-dispatch to fill any freed slot — all driven by Orchestrator's
 * `onRunTerminal` push hook (plus `task.changed` for a blocker satisfied
 * outside any run), never a poll. A session covers its container's whole
 * fan-out scope (a project's milestone issues too) and never starts a
 * teammate's task: one assigned to a person other than whoever started it.
 * A session pauses itself at its spend or run ceiling (or after a fill keeps
 * failing) and waits for `resume()`; `stop()` and a pause only halt *new*
 * dispatches — runs already live keep running to their own completion.
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
  // Per active session, what its unstarted work waited on at the last fill:
  // blockers, and its own tasks a teammate held (see onTasksChanged). Memory
  // only; the next fill rebuilds it.
  private readonly watching = new Map<string, Watched>();

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
    ctx.events.subscribe((event) => {
      if (event.type === 'task.changed') this.onTasksChanged(event.ids);
    });
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
    opts: EpicSessionOptions & {
      executor?: string;
      startedBy?: string;
      operator?: string;
    } = {}
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
    this.refuseOverlap(epicId);
    const now = new Date().toISOString();
    const session: EpicSessionRecord = {
      concurrency,
      executor,
      state: 'active',
      maxSpendUsd,
      maxRuns,
      startedAt: now,
      startedBy: opts.startedBy ?? this.ctx.actorContext?.humanRef ?? null,
      scope: 'plan',
      updatedAt: now,
      ...(opts.operator === undefined ? {} : { operator: opts.operator }),
      heldCritical: new Set(),
    };
    this.sessions.set(epicId, session);
    this.armed.add(epicId);
    this.persist();
    try {
      this.appendEpicActivity(
        epicId,
        `epic dispatch started ${describeSession(session)}`,
        session.startedBy ?? undefined
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
  // already made. A given `operator` re-keys who the fills act for (null: no one).
  async resume(
    epicId: string,
    opts: EpicSessionOptions & { operator?: string | null } = {}
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
    if (opts.operator === null) delete session.operator;
    else if (opts.operator !== undefined) session.operator = opts.operator;
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
    this.watching.delete(epicId);
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
    return this.progressOf(epicId, this.progressBoard());
  }

  // What every epic's progress reads alike, read once per request: on a
  // 2000-task board the dispatchable set alone is a pass over every task,
  // which progressAll() used to repeat per milestone.
  private progressBoard(): ProgressBoard {
    const statuses = statusModelFor(this.ctx.rootDir);
    const tasks = this.ctx.cache.allItems();
    const runs = this.ctx.orchestrator.list();
    const latestRun = new Map<string, RunMeta>();
    const liveRun = new Map<string, RunMeta>();
    for (const run of runs) {
      if (!latestRun.has(run.taskId)) latestRun.set(run.taskId, run);
      if (!liveRun.has(run.taskId) && !TERMINAL_RUN_STATES.has(run.state)) {
        liveRun.set(run.taskId, run);
      }
    }
    return {
      statuses,
      byId: new Map(tasks.map((t) => [t.meta.id, t])),
      children: childrenIndex(tasks),
      dispatchable: new Set(
        dispatchableTasks(tasks, statuses).map((t) => t.meta.id)
      ),
      runs,
      latestRun,
      liveRun,
      withRunBranch: tasksWithRunBranch(runs),
      readings: new Map(),
      runCostEstimateUsd: loadConfig(this.ctx.rootDir).orchestrator
        .runCostEstimateUsd,
    };
  }

  private progressOf(epicId: string, board: ProgressBoard): EpicProgress {
    const { statuses, dispatchable } = board;
    const children = this.scopeOf(epicId, (id) => board.children.get(id) ?? []);
    const childIds = new Set(children.map((c) => c.meta.id));
    const childRuns = board.runs.filter((r) => childIds.has(r.taskId));
    const liveRuns = childRuns.filter((r) => !TERMINAL_RUN_STATES.has(r.state));
    const waves = deriveWaves(children);
    const session = this.sessions.get(epicId);
    const { dispatcher, holder } = this.holderFor(session);
    const blocker = blockerView(holder, board.withRunBranch);
    const progressChildren: EpicProgressChild[] = children.map((task) => {
      const id = task.meta.id;
      const key = `${dispatcher} ${id}`;
      let reading = board.readings.get(key);
      if (reading === undefined) {
        const latestRun = board.latestRun.get(id) ?? null;
        const derived = deriveChildPhase({
          task,
          liveRun: board.liveRun.get(id) ?? null,
          latestRun,
          fixLoop: this.fixLoop?.get(id) ?? null,
          blockedReason: this.ctx.orchestrator.blockedFindingReason(id),
          unsatisfiedBlockers: fanoutWaitingOn(
            task,
            (blockerId) => board.byId.get(blockerId),
            statuses,
            blocker
          ),
          dispatchable: dispatchable.has(id),
          heldBy: holder(task),
          statuses,
        });
        reading = {
          id,
          title: task.meta.title,
          status: task.meta.status,
          phase: derived.phase,
          ...(derived.reason !== undefined ? { reason: derived.reason } : {}),
          ...(derived.runId !== undefined ? { runId: derived.runId } : {}),
          ...(latestRun?.costUsd !== undefined
            ? { costUsd: latestRun.costUsd }
            : {}),
          openFindings: this.ctx.findingStore?.openFor(id).length ?? 0,
        };
        board.readings.set(key, reading);
      }
      return { ...reading, wave: waves.get(id) ?? 1 };
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
        board.runCostEstimateUsd,
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
    const board = this.progressBoard();
    return this.ctx.cache
      .query({ containers: true })
      .map((epic) => epic.meta.id)
      .sort()
      .map((epicId) => this.progressOf(epicId, board));
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

  // The session's spend: every run on a task in its scope created since
  // `startedAt`, charged at the current config estimate while live.
  private sessionSpend(
    epicId: string,
    session: EpicSessionRecord,
    estimate = loadConfig(this.ctx.rootDir).orchestrator.runCostEstimateUsd,
    childIds: ReadonlySet<string> = new Set(
      this.scopeOf(epicId).map((c) => c.meta.id)
    )
  ): EpicSpend {
    return deriveSpend(
      this.ctx.orchestrator.list().filter((r) => childIds.has(r.taskId)),
      session.startedAt,
      estimate,
      { maxSpendUsd: session.maxSpendUsd, maxRuns: session.maxRuns }
    );
  }

  // Dispatches ready work in the session's scope (the tasks the Flight Plan
  // draws, see scopeOf) via schedulableBatch (conflicts.ts): concurrency cap,
  // then the run and spend ceilings, no two overlapping `writes` in one batch.
  // A teammate's task is never a candidate, and holds its dependents until it
  // is done (core's releasesFanoutDependents). Readiness runs over the FULL
  // task set first, since dispatchableTasks treats a blocker it wasn't given
  // as satisfied — a blocker in another epic, or in none, must still count.
  // The ceilings are only consulted once there is something to gate, so a
  // session never pauses with nothing to dispatch.
  private async fillQueue(epicId: string): Promise<void> {
    const session = this.sessions.get(epicId);
    if (session?.state !== 'active' || !this.armed.has(epicId)) return;

    const scope = this.scopeOf(epicId);
    const work = this.ownWork(epicId, scope, this.cacheLookup());
    const workIds = new Set(work.map((c) => c.meta.id));
    const runs = this.ctx.orchestrator.list();
    const liveCount = runs.filter(
      (r) => workIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
    ).length;
    let slots = session.concurrency - liveCount;
    // A full session refills on its next terminal, which re-reads all this.
    if (slots <= 0) return;

    const tasks = this.ctx.cache.query({ includeArchived: true });
    const statuses = statusModelFor(this.ctx.rootDir);
    const { dispatcher, holder } = this.holderFor(session);
    const mine = new Set(
      work.filter((t) => holder(t) === null).map((t) => t.meta.id)
    );
    const byId = new Map(tasks.map((t) => [t.meta.id, t]));
    const blocker = blockerView(holder, tasksWithRunBranch(runs));
    const waitingOn = (t: TaskDoc) =>
      fanoutWaitingOn(t, (id) => byId.get(id), statuses, blocker);
    this.noteWatched(epicId, work, mine, statuses, waitingOn);
    // The scope includes archived children (see scopeOf); dispatchability
    // must exclude them explicitly. dispatchableTasks releases a dependent at
    // a blocker's review role; a fan-out also wants a branch to stack on.
    const ready = dispatchableTasks(tasks, statuses).filter(
      (t) =>
        mine.has(t.meta.id) &&
        t.meta.archivedAt === undefined &&
        waitingOn(t).length === 0 &&
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
      const spend = this.sessionSpend(
        epicId,
        session,
        estimate,
        new Set(scope.map((c) => c.meta.id))
      );
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
    // The orchestrator re-asks this of the task as it stands right before its
    // run registers: a Linear pull can hand it to a teammate mid-batch.
    const guard = (task: TaskDoc): string | null => {
      const heldBy = holder(task);
      if (heldBy !== null) return `assigned to ${heldBy}`;
      return isUnstartedStatus(task.meta.status, statuses)
        ? null
        : `status is now ${task.meta.status}`;
    };
    for (const taskId of batch) {
      const task = clearOfLiveRuns.find((t) => t.meta.id === taskId);
      // MEM-R8(b): the run acts for the session's operator only on a task
      // that operator created and last wrote.
      const operator =
        task === undefined || this.ctx.authorship === undefined
          ? null
          : this.ctx.authorship.actsFor(task, session.operator ?? null);
      try {
        // The epic scheduler's own auto-fill decided this task was next —
        // no human pressed dispatch for it specifically, but the run is the
        // starter's work (a legacy session's, the local human's). Through
        // dispatchOrResume, not dispatch: a task whose last run a restart left
        // recoverable must be picked back up here too, since a fresh run would
        // strand that worktree and cancel the sweep still watching it.
        await this.ctx.orchestrator.dispatchOrResume(taskId, {
          executor: session.executor,
          actor: 'none',
          operator,
          dispatchedBy: dispatcher,
          guard,
        });
      } catch (err) {
        // A task that already picked up a live run outside this session, or
        // that the guard refused (raced between the readiness snapshot and
        // here), just gets skipped.
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
  // nothing accomplished). A teammate's task is theirs to finish: only the
  // session's own work waiting on it keeps the session open.
  private isEpicComplete(epicId: string): boolean {
    const scope = this.scopeOf(epicId);
    if (scope.length === 0) return false;
    const children = this.ownWork(epicId, scope, this.cacheLookup());
    const statuses = statusModelFor(this.ctx.rootDir);
    const { holder } = this.holderFor(this.sessions.get(epicId));
    if (
      children.some(
        (c) =>
          holder(c) === null &&
          (isUnstartedStatus(c.meta.status, statuses) ||
            hasStatusRole(c.meta.status, 'dispatched', statuses))
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
    this.watching.delete(epicId);
    this.clearFillRetry(epicId);
    this.appendEpicActivity(
      epicId,
      'epic dispatch session ended — no children left to dispatch',
      'none'
    );
    this.persist();
    this.emitChanged(epicId);
  }

  // The tasks `epicId`'s fan-out covers (core's fanoutScope): exactly what
  // its Flight Plan draws, a project's milestone issues included — unless a
  // live session keeps the direct-children rule it was started under.
  // Includes archived ones: progress/completeness are historical facts about
  // the epic, and an archived child is done+pushed, not missing.
  // Walks the cache unless given a board's `childrenOf` (progress reads
  // body-less items).
  private scopeOf(
    epicId: string,
    childrenOf?: undefined,
    rule?: EpicSessionScope
  ): TaskDoc[];
  private scopeOf<T extends TaskListItem>(
    epicId: string,
    childrenOf: (id: string) => readonly T[],
    rule?: EpicSessionScope
  ): T[];
  private scopeOf(
    epicId: string,
    childrenOf: (id: string) => readonly TaskListItem[] = (id) =>
      this.ctx.cache.query({ parent: id, includeArchived: true }),
    rule: EpicSessionScope = this.scopeRuleOf(epicId)
  ): TaskListItem[] {
    return rule === 'direct'
      ? childrenOf(epicId).filter((t) => !isContainerKind(t.meta.kind))
      : fanoutScope(epicId, childrenOf);
  }

  // A live session's scope rule; `plan` for any fan-out yet to start.
  private scopeRuleOf(epicId: string): EpicSessionScope {
    const session = this.sessions.get(epicId);
    return session !== undefined && isLive(session) ? session.scope : 'plan';
  }

  // cache.get, memoized for one walk up the hierarchy.
  private cacheLookup(): (id: string) => TaskDoc | null {
    const memo = new Map<string, TaskDoc | null>();
    return (id) => {
      if (!memo.has(id)) memo.set(id, this.ctx.cache.get(id));
      return memo.get(id) ?? null;
    };
  }

  // A session's own work: its scope, less any task a nearer active or paused
  // session covers. start() refuses overlapping sessions, so this only bites
  // on sessions persisted before a scope reached past direct children.
  private ownWork(
    epicId: string,
    scope: TaskDoc[],
    lookup: (id: string) => TaskDoc | null | undefined
  ): TaskDoc[] {
    const liveSession = (id: string): boolean => {
      const session = this.sessions.get(id);
      return session !== undefined && isLive(session);
    };
    if (
      ![...this.sessions.keys()].some((id) => id !== epicId && liveSession(id))
    ) {
      return scope;
    }
    return scope.filter(
      (task) => fanoutCoverers(task, lookup).find(liveSession) === epicId
    );
  }

  // One fan-out per task: refuses a start whose scope shares a task with
  // another active or paused session, such as a project's and one of its
  // milestones'.
  private refuseOverlap(epicId: string): void {
    let mine: ReadonlySet<string> | null = null;
    for (const [otherId, other] of this.sessions) {
      if (otherId === epicId || !isLive(other)) continue;
      mine ??= new Set(
        this.scopeOf(epicId, undefined, 'plan').map((t) => t.meta.id)
      );
      const scope = mine;
      const shared = this.scopeOf(otherId).filter((t) =>
        scope.has(t.meta.id)
      ).length;
      if (shared > 0) {
        throw new OrchestratorConflictError(
          `fan-out would overlap ${otherId}'s ${other.state} session on ${shared} task(s) — stop that one first: ${epicId}`
        );
      }
    }
  }

  // Who holds a task against `session` (core's fanoutHolder): the teammate
  // it belongs to, or null when the session may start it. Without a session,
  // the local human's view.
  private holderFor(session: EpicSessionRecord | undefined): {
    dispatcher: string;
    holder: (task: TaskListItem) => string | null;
  } {
    const local = this.ctx.actorContext?.humanRef;
    const dispatcher = session?.startedBy ?? local ?? 'human';
    const localRef = local ?? dispatcher;
    return {
      dispatcher,
      holder: (task) => fanoutHolder(task.meta.assignee, dispatcher, localRef),
    };
  }

  // Records, for onTasksChanged, the blockers the session's own unstarted
  // work (`mine`) still waits on and the unstarted tasks a teammate holds.
  private noteWatched(
    epicId: string,
    work: readonly TaskDoc[],
    mine: ReadonlySet<string>,
    statuses: StatusModel,
    waitingOn: (task: TaskDoc) => string[]
  ): void {
    const watched: Watched = { waiting: new Set(), held: new Set() };
    for (const task of work) {
      if (task.meta.archivedAt !== undefined) continue;
      if (!isUnstartedStatus(task.meta.status, statuses)) continue;
      if (!mine.has(task.meta.id)) {
        watched.held.add(task.meta.id);
        continue;
      }
      for (const id of waitingOn(task)) watched.waiting.add(id);
    }
    this.watching.set(epicId, watched);
  }

  // Work can free up outside any run: a teammate's issue landing through
  // Linear, a hand edit, or a teammate handing their task back. Runs fire
  // onRunTerminal; this catches the rest, refilling a session only when a
  // blocker it waited on now lets go or a task it held back is now its own.
  private onTasksChanged(ids: readonly string[] | undefined): void {
    let statuses: StatusModel | null = null;
    let withRunBranch: Set<string> | null = null;
    for (const [epicId, { waiting, held }] of this.watching) {
      if (!this.armed.has(epicId)) continue;
      const session = this.sessions.get(epicId);
      if (session?.state !== 'active') continue;
      const touched = (set: ReadonlySet<string>) =>
        ids === undefined ? [...set] : ids.filter((id) => set.has(id));
      const blockers = touched(waiting);
      const holding = touched(held);
      if (blockers.length === 0 && holding.length === 0) continue;
      statuses ??= statusModelFor(this.ctx.rootDir);
      withRunBranch ??= tasksWithRunBranch(this.ctx.orchestrator.list());
      const model = statuses;
      const { holder } = this.holderFor(session);
      const view = blockerView(holder, withRunBranch);
      const released = blockers.some((id) => {
        const blocker = this.ctx.cache.get(id);
        return (
          blocker === null ||
          releasesFanoutDependents(blocker.meta.status, model, view(blocker))
        );
      });
      const handedBack = holding.some((id) => {
        const task = this.ctx.cache.get(id);
        return (
          task !== null &&
          holder(task) === null &&
          isUnstartedStatus(task.meta.status, model)
        );
      });
      if (released || handedBack) this.scheduleFill(epicId);
    }
  }

  private requireEpic(epicId: string): TaskDoc {
    const epic = this.ctx.store.get(epicId);
    if (epic === null) {
      throw new OrchestratorNotFoundError(`epic not found: ${epicId}`);
    }
    if (
      !isContainerKind(epic.meta.kind) &&
      !this.ctx.cache.isContainer(epicId)
    ) {
      throw new OrchestratorClientError(`not a container: ${epicId}`);
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
    this.ctx.cache.refresh(this.ctx.store, [epicId]);
    this.ctx.events.broadcast({ type: 'task.changed', ids: [epicId] });
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
        startedBy:
          typeof record.startedBy === 'string' ? record.startedBy : null,
        scope: record.scope === 'plan' ? 'plan' : 'direct',
        updatedAt:
          typeof record.updatedAt === 'string'
            ? record.updatedAt
            : record.startedAt,
        ...(record.completedAt !== undefined
          ? { completedAt: record.completedAt }
          : {}),
        ...(typeof record.operator === 'string'
          ? { operator: record.operator }
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
      startedBy: session.startedBy,
      scope: session.scope,
      updatedAt: session.updatedAt,
      ...(session.completedAt !== undefined
        ? { completedAt: session.completedAt }
        : {}),
      ...(session.operator !== undefined ? { operator: session.operator } : {}),
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
