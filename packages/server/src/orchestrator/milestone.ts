import {
  claimConflictsWithWrites,
  dispatchableTasks,
  fanoutCoverers,
  fanoutHolder,
  fanoutScope,
  fanoutWaitingOn,
  hasStatusRole,
  isContainerKind,
  isReviewStatus,
  isUnstartedStatus,
  loadConfig,
  releasesFanoutDependents,
  tasksConflict,
} from '@dispatch-foo/core';
import type {
  ActorContext,
  FanoutBlocker,
  StatusModel,
  TaskDoc,
  TaskListItem,
  TaskStorePort,
} from '@dispatch-foo/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { FindingStorePort } from '../findings.js';
import { statusModelFor } from '../statuses.js';
import type { FixLoopState } from './fixLoop.js';
import {
  deriveChildPhase,
  deriveSpend,
  deriveWaves,
  summarizeWaves,
} from './milestonePhase.js';
import type {
  MilestoneProgressChild,
  MilestoneSpend,
  MilestoneWave,
} from './milestonePhase.js';
import type { Orchestrator } from './orchestrator.js';
import { milestoneSessionsPath, runsDir } from './paths.js';
import type { TaskAuthorship } from './taskAuthorship.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  tasksWithFinishedRun,
  TERMINAL_RUN_STATES,
} from './types.js';

type MilestoneSessionState = 'active' | 'paused' | 'stopped' | 'complete';
export type MilestonePauseReason = 'human' | 'budget' | 'runs' | 'fill-failed';
/** What a session covers: its container's whole fan-out scope (core's
 *  fanoutScope), or only its direct children — the rule a session persisted
 *  before plan-wide fan-outs was started under, and keeps. */
type MilestoneSessionScope = 'plan' | 'direct';

// One milestone's dispatch session. Persisted write-through to
// `milestoneSessionsPath` (see persist()/hydrate()) so a dispatchd restart re-arms
// an active session instead of forgetting it; the fill chain, retry counter
// and boot arm flag are memory-only and reset on boot. Spend and run counts
// are never stored — they are derived from the run registry on every read.
interface MilestoneSessionRecord {
  /** Execute + review + verify slots — liveCount is kind-agnostic by design. */
  concurrency: number;
  executor: string;
  state: MilestoneSessionState;
  /** Set while paused, cleared on resume. */
  pausedReason?: MilestonePauseReason;
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
  scope: MilestoneSessionScope;
  updatedAt: string;
  completedAt?: string;
  /** The human its auto-fill runs act for; absent when the shared agentToken
   *  started it. */
  operator?: string;
  /** Critical-risk children already noted as held on the milestone's Activity,
   *  so each is announced once per session rather than on every fill. */
  heldCritical: Set<string>;
}

// The on-disk shape of one record: the Set becomes an array.
type PersistedSessionRecord = Omit<MilestoneSessionRecord, 'heldCritical'> & {
  heldCritical: string[];
};

interface MilestoneSessionsSnapshot {
  version: 1;
  sessions: Record<string, PersistedSessionRecord>;
}

export interface MilestoneSession {
  milestoneId: string;
  concurrency: number;
  executor: string;
  state: MilestoneSessionState;
  pausedReason?: MilestonePauseReason;
  pausedDetail?: string;
  maxSpendUsd: number | null;
  maxRuns: number | null;
  startedAt: string;
  /** Who started it; teammates' tasks are never auto-dispatched for them. */
  startedBy: string | null;
  /** The whole plan, or (a session from before plan-wide fan-outs) its
   *  container's direct children only. */
  scope: MilestoneSessionScope;
  updatedAt: string;
  completedAt?: string;
  /** The human its auto-fill runs act for; absent when the shared agentToken
   *  started it. */
  operator?: string;
  /** `state === 'active'` — kept for `formatMilestoneProgress` and `--watch`. */
  active: boolean;
}

export interface MilestoneProgress {
  milestoneId: string;
  active: boolean;
  concurrency?: number;
  session: MilestoneSession | null;
  /** For the session's runs, or for every child run when there is none. */
  spend: MilestoneSpend;
  children: MilestoneProgressChild[];
  waves: MilestoneWave[];
  liveRuns: RunMeta[];
}

/** The ceilings and concurrency a session may be started or resumed with. */
export interface MilestoneSessionOptions {
  concurrency?: number;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
}

/** The narrow view of FixLoop the engine reads phases from — bound late
 *  because FixLoop is constructed after the engine (see bindFixLoop). */
export interface MilestoneFixLoopPort {
  get(taskId: string): FixLoopState | null;
  list(): FixLoopState[];
}

export interface MilestoneEngineContext {
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
  // The `milestone.changed` debounce window; `0` broadcasts synchronously so a
  // test can assert right after the call.
  eventDebounceMs?: number;
  // Optional, same "tests may omit it" contract as OrchestratorContext's own
  // field — appendMilestoneActivity() below falls back to an unattributed
  // Activity line when it's absent.
  actorContext?: ActorContext;
  // Who wrote each task; absent, every auto-fill run acts for no one.
  authorship?: TaskAuthorship;
}

// How long a fill that failed outright waits before retrying itself, and how
// many consecutive retries one milestone gets before it pauses on its own.
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
function describeSession(session: MilestoneSessionRecord): string {
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
    // `?? undefined` so a reviewedAt written as null (an older transcript)
    // still reads as unreviewed instead of hiding the branch forever.
    if (
      TERMINAL_RUN_STATES.has(run.state) &&
      (run.reviewedAt ?? undefined) === undefined
    ) {
      out.add(run.taskId);
    }
  }
  return out;
}

// A blocker as a fan-out working for `holder`'s dispatcher sees it.
function blockerView(
  holder: (task: TaskListItem) => string | null,
  withRunBranch: ReadonlySet<string>,
  finished: ReadonlySet<string>
): (blocker: TaskListItem) => FanoutBlocker {
  return (blocker) => ({
    held: holder(blocker) !== null,
    hasRunBranch: withRunBranch.has(blocker.meta.id),
    finishedRun: finished.has(blocker.meta.id),
  });
}

// What a session's last fill left waiting (see MilestoneEngine.onTasksChanged).
interface Watched {
  /** Blockers its own unstarted work waits on. */
  waiting: Set<string>;
  /** Its unstarted tasks a teammate holds. */
  held: Set<string>;
}

// Active or paused: a session that still claims its scope.
function isLive(session: MilestoneSessionRecord): boolean {
  return session.state === 'active' || session.state === 'paused';
}

// One child's reading, shared by every container whose scope holds it (a
// milestone's and its project's): only the wave differs between them.
type ChildReading = Omit<MilestoneProgressChild, 'wave'>;

// The board as progress() reads it, shared by every milestone in one request.
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
  /** See tasksWithFinishedRun. */
  finished: Set<string>;
  /** Readings by `<dispatcher> <task id>`, filled as containers ask. */
  readings: Map<string, ChildReading>;
  runCostEstimateUsd: number;
}

/**
 * The milestone-level parallel dispatch engine (spec §5 Dispatch step 6): starting
 * a milestone dispatches its ready children up to a concurrency cap, and every
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
 * The session record is persisted to `milestoneSessionsPath` (write-through, like
 * MergeQueue) so a restart re-arms it through resumeOnBoot(); the durable
 * trail a human reads is still the milestone Activity lines this class appends
 * via TaskStore, same as every other orchestrator lifecycle event.
 */
export class MilestoneEngine {
  private readonly sessions = new Map<string, MilestoneSessionRecord>();
  // Sessions allowed to fill. A hydrated `active` session stays out of this
  // set until resumeOnBoot()'s timer adds it; start()/resume() add it directly.
  private readonly armed = new Set<string>();
  // One serialization chain per milestone — see scheduleFill() for why fillQueue
  // can no longer simply be called from the run-lifecycle hooks.
  private readonly fillChains = new Map<string, Promise<void>>();
  // Self-retry state per milestone: the pending timer and how many consecutive
  // retries it has already spent (see armFillRetry).
  private readonly fillRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly fillRetryAttempts = new Map<string, number>();
  private readonly fillRetryDelayMs: number;
  private readonly resumeDelayMs: number;
  private readonly eventDebounceMs: number;
  // Pending trailing `milestone.changed` broadcast per milestone (see emitChanged).
  private readonly changedTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // resumeOnBoot()'s pending re-arm timers, so shutdown() can cancel them.
  private readonly resumeTimers = new Set<ReturnType<typeof setTimeout>>();
  // Set by shutdown(): no fill starts and nothing persists after it.
  private closed = false;
  private fixLoop: MilestoneFixLoopPort | null = null;
  // Per active session, what its unstarted work waited on at the last fill:
  // blockers, and its own tasks a teammate held (see onTasksChanged). Memory
  // only; the next fill rebuilds it.
  private readonly watching = new Map<string, Watched>();
  // Why each ready task in a milestone's scope was last left unstarted, by
  // milestone then task id. Lets noteFillHold write a reason once and again
  // only when it changes; a task drops out once it starts or stops being
  // ready.
  private readonly fillHolds = new Map<string, Map<string, string>>();

  constructor(private readonly ctx: MilestoneEngineContext) {
    this.fillRetryDelayMs = ctx.fillRetryDelayMs ?? DEFAULT_FILL_RETRY_DELAY_MS;
    this.resumeDelayMs = ctx.resumeDelayMs ?? BOOT_RESUME_DELAY_MS;
    this.eventDebounceMs = ctx.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS;
    this.hydrate();
    // Two distinct triggers can make a milestone's next dispatch decision stale:
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

  // Whether any milestone is still dispatching work. A paused, stopped or complete
  // milestone waits on a human and can wait just as well in a restarted daemon.
  hasActiveSession(): boolean {
    for (const record of this.sessions.values()) {
      if (record.state === 'active') return true;
    }
    return false;
  }

  // FixLoop is constructed after this engine (its terminal hook must run
  // after the review runner's), so the phase reads bind to it late. Until
  // bound, no child ever reads as fixing/reviewing-by-loop/capped.
  bindFixLoop(port: MilestoneFixLoopPort): void {
    this.fixLoop = port;
  }

  // POST /api/milestones/:id/dispatch. `concurrency` defaults to the project's
  // `orchestrator.milestoneConcurrency` config; `executor` defaults to the project's
  // but tests override it (see the Global Constraints note on honoring a
  // body override) to dispatch through FakeExecutor instead.
  // Async only because the initial fillQueue is awaited: start() must still
  // be able to tear its own session down when that very first dispatch
  // throws (see the catch below), which a fire-and-forget `void` could not.
  async start(
    milestoneId: string,
    opts: MilestoneSessionOptions & {
      executor?: string;
      startedBy?: string;
      operator?: string;
    } = {}
  ): Promise<MilestoneSession> {
    const milestone = this.requireMilestone(milestoneId);
    const existing = this.sessions.get(milestoneId);
    if (existing?.state === 'active') {
      throw new OrchestratorConflictError(
        `milestone already has an active dispatch session: ${milestoneId}`
      );
    }
    if (existing?.state === 'paused') {
      throw new OrchestratorConflictError(
        `milestone already has a dispatch session (paused) — resume or stop it first: ${milestoneId}`
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
      opts.concurrency ?? orchestratorConfig.milestoneConcurrency,
      orchestratorConfig.maxConcurrency
    );
    const maxSpendUsd = validateMaxSpend(opts.maxSpendUsd ?? null);
    const maxRuns = validateMaxRuns(opts.maxRuns ?? null);
    this.refuseOverlap(milestoneId);
    const now = new Date().toISOString();
    const session: MilestoneSessionRecord = {
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
    this.sessions.set(milestoneId, session);
    this.armed.add(milestoneId);
    this.persist();
    try {
      this.appendMilestoneActivity(
        milestoneId,
        `milestone dispatch started ${describeSession(session)}`,
        session.startedBy ?? undefined
      );
      // Chained like every other fill (see enqueueFill) — a run reaching a
      // terminal state *inside* this very dispatch fires the lifecycle hooks
      // synchronously, so a hook-driven fill can otherwise interleave with
      // this one. Rejections still propagate here, which is what keeps the
      // session rollback below working.
      await this.enqueueFill(milestoneId);
    } catch (err) {
      // C2(a): never leave a wedged session behind a failed initial
      // dispatch — a retry (even with identical args) must start clean,
      // not 409 on "already has an active session" for a session that
      // never actually got off the ground.
      this.sessions.delete(milestoneId);
      this.armed.delete(milestoneId);
      this.persist();
      throw err;
    }
    this.emitChanged(milestoneId);
    return this.publicSession(milestone.meta.id, session);
  }

  // POST /api/milestones/:id/pause. Halts new dispatches until resume(); anything
  // already live keeps running.
  pause(milestoneId: string): MilestoneSession {
    this.requireMilestone(milestoneId);
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'active') {
      throw new OrchestratorConflictError(
        `milestone has no active dispatch session: ${milestoneId}`
      );
    }
    session.state = 'paused';
    session.pausedReason = 'human';
    delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.clearFillRetry(milestoneId);
    this.appendMilestoneActivity(
      milestoneId,
      'milestone dispatch paused by you (live runs continue)'
    );
    this.persist();
    this.emitChanged(milestoneId);
    return this.publicSession(milestoneId, session);
  }

  // POST /api/milestones/:id/resume. The mid-session throttle and "raise the
  // ceiling" verb: overrides are validated like start()'s, then the session
  // fills again. `startedAt` is untouched, so spend keeps counting the runs
  // already made. A given `operator` re-keys who the fills act for (null: no one).
  async resume(
    milestoneId: string,
    opts: MilestoneSessionOptions & { operator?: string | null } = {}
  ): Promise<MilestoneSession> {
    this.requireMilestone(milestoneId);
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'paused') {
      throw new OrchestratorConflictError(
        `milestone has no paused dispatch session: ${milestoneId}`
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
    this.armed.add(milestoneId);
    this.appendMilestoneActivity(
      milestoneId,
      `milestone dispatch resumed ${describeSession(session)}`
    );
    this.persist();
    try {
      await this.enqueueFill(milestoneId);
    } catch (err) {
      // Back to paused with the reason on the record, so the card shows why
      // and a second resume can try again; the caller still sees the error.
      session.state = 'paused';
      session.pausedReason = 'fill-failed';
      session.pausedDetail = (err as Error).message;
      session.updatedAt = new Date().toISOString();
      this.persist();
      this.emitChanged(milestoneId);
      throw err;
    }
    this.emitChanged(milestoneId);
    return this.publicSession(milestoneId, session);
  }

  // POST /api/milestones/:id/stop. Halts new dispatches only — anything already
  // live keeps running to its own natural finish/fail/cancel.
  stop(milestoneId: string): MilestoneSession {
    this.requireMilestone(milestoneId);
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'active' && session?.state !== 'paused') {
      throw new OrchestratorConflictError(
        `milestone has no active dispatch session: ${milestoneId}`
      );
    }
    session.state = 'stopped';
    delete session.pausedReason;
    delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.armed.delete(milestoneId);
    this.watching.delete(milestoneId);
    this.clearFillRetry(milestoneId);
    this.appendMilestoneActivity(
      milestoneId,
      'milestone dispatch stopped (new dispatches halted; live runs continue)'
    );
    this.persist();
    this.emitChanged(milestoneId);
    return this.publicSession(milestoneId, session);
  }

  // GET /api/milestones/:id/progress: every child with its server-derived phase
  // and wave, the session, its spend, and the live runs dispatched against
  // any child.
  progress(milestoneId: string): MilestoneProgress {
    this.requireMilestone(milestoneId);
    return this.progressOf(milestoneId, this.progressBoard());
  }

  // What every milestone's progress reads alike, read once per request: on a
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
    const finished = tasksWithFinishedRun(runs);
    return {
      statuses,
      byId: new Map(tasks.map((t) => [t.meta.id, t])),
      children: childrenIndex(tasks),
      dispatchable: new Set(
        dispatchableTasks(tasks, statuses, (id) => finished.has(id)).map(
          (t) => t.meta.id
        )
      ),
      runs,
      latestRun,
      liveRun,
      withRunBranch: tasksWithRunBranch(runs),
      finished,
      readings: new Map(),
      runCostEstimateUsd: loadConfig(this.ctx.rootDir).orchestrator
        .runCostEstimateUsd,
    };
  }

  private progressOf(
    milestoneId: string,
    board: ProgressBoard
  ): MilestoneProgress {
    const { statuses, dispatchable } = board;
    const children = this.scopeOf(
      milestoneId,
      (id) => board.children.get(id) ?? []
    );
    const childIds = new Set(children.map((c) => c.meta.id));
    const childRuns = board.runs.filter((r) => childIds.has(r.taskId));
    const liveRuns = childRuns.filter((r) => !TERMINAL_RUN_STATES.has(r.state));
    const waves = deriveWaves(children);
    const session = this.sessions.get(milestoneId);
    const { dispatcher, holder } = this.holderFor(session);
    const blocker = blockerView(holder, board.withRunBranch, board.finished);
    const progressChildren: MilestoneProgressChild[] = children.map((task) => {
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
          finishedRun: board.finished.has(id),
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
      milestoneId,
      active: session?.state === 'active',
      concurrency: session?.concurrency,
      session:
        session === undefined ? null : this.publicSession(milestoneId, session),
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

  // GET /api/milestones/progress: progress() for every non-archived milestone (the
  // desktop's `data.milestones` set), in id order — one request for every surface
  // that shows a milestone.
  progressAll(): MilestoneProgress[] {
    const board = this.progressBoard();
    return this.ctx.cache
      .query({ containers: true })
      .map((milestone) => milestone.meta.id)
      .sort()
      .map((milestoneId) => this.progressOf(milestoneId, board));
  }

  // Re-arms every session hydrated as `active`, each after `resumeDelayMs`
  // so the orchestrator's quiet-tree auto-resume claims the previous
  // process's crash victims first. Paused/stopped/complete records are left
  // alone — a budget pause survives a restart, preserving the human's
  // decision. Returns how many were scheduled, for the boot log.
  resumeOnBoot(): number {
    let count = 0;
    for (const [milestoneId, session] of this.sessions) {
      if (session.state !== 'active' || this.armed.has(milestoneId)) continue;
      count++;
      const timer = setTimeout(() => {
        this.resumeTimers.delete(timer);
        const current = this.sessions.get(milestoneId);
        if (current === undefined || current.state !== 'active') return;
        this.armed.add(milestoneId);
        this.scheduleFill(milestoneId);
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
  // frees a concurrency slot (or, for a single-child milestone, can complete it
  // outright). C1: this reacts across EVERY active session, not just the
  // one owning the terminated run's own task — a run's terminal state can
  // be exactly what unblocks a *different* milestone's child (a cross-milestone
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
    for (const [milestoneId, session] of [...this.sessions]) {
      if (session.state !== 'active') continue;
      if (this.isMilestoneComplete(milestoneId)) {
        this.completeMilestone(milestoneId);
      } else {
        this.scheduleFill(milestoneId);
      }
    }
  }

  /**
   * Appends a fillQueue pass for `milestoneId` to that milestone's serialization chain
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
  private enqueueFill(milestoneId: string): Promise<void> {
    const previous = this.fillChains.get(milestoneId) ?? Promise.resolve();
    const pass = previous.then(() => this.fillQueue(milestoneId));
    this.fillChains.set(
      milestoneId,
      pass.catch(() => {})
    );
    return pass;
  }

  // Fire-and-forget fill for the run-lifecycle hooks, which have no caller
  // left to receive a rejection — an unhandled one would take the daemon
  // down. Failures are recorded rather than propagated, matching
  // invokeHooksSafely's rule for a throwing subscriber.
  private scheduleFill(milestoneId: string): void {
    if (this.closed) return;
    void this.enqueueFill(milestoneId).then(
      () => this.fillRetryAttempts.delete(milestoneId),
      (err: unknown) => {
        // A fill already in flight at shutdown must not arm a new retry.
        if (this.closed) return;
        const message = (err as Error).message;
        this.recordFillFailure(milestoneId, message);
        this.armFillRetry(milestoneId, message);
      }
    );
  }

  // A fill that dispatched nothing fires no lifecycle hook, so nothing else
  // would ever retry it. Bounded: a failure that repeats is not transient,
  // so past the budget the session pauses with the message instead of going
  // silently idle.
  private armFillRetry(milestoneId: string, message: string): void {
    const attempts = (this.fillRetryAttempts.get(milestoneId) ?? 0) + 1;
    if (attempts > MAX_FILL_RETRIES) {
      this.pauseFor(milestoneId, 'fill-failed', message);
      return;
    }
    this.fillRetryAttempts.set(milestoneId, attempts);
    clearTimeout(this.fillRetryTimers.get(milestoneId));
    const timer = setTimeout(() => {
      this.fillRetryTimers.delete(milestoneId);
      const session = this.sessions.get(milestoneId);
      if (session?.state !== 'active') return;
      this.scheduleFill(milestoneId);
    }, this.fillRetryDelayMs);
    // Never a reason to keep the daemon (or a test process) alive.
    timer.unref?.();
    this.fillRetryTimers.set(milestoneId, timer);
  }

  private clearFillRetry(milestoneId: string): void {
    clearTimeout(this.fillRetryTimers.get(milestoneId));
    this.fillRetryTimers.delete(milestoneId);
    this.fillRetryAttempts.delete(milestoneId);
  }

  // The durable half of that rule: invokeHooksSafely doesn't just log a
  // failed hook, it appends an Activity line, rebuilds the cache and
  // broadcasts, so the failure is visible in the UI rather than only in the
  // daemon's stderr. An auto-dispatch that silently stops filling is exactly
  // the kind of thing a user needs told about, so this mirrors both halves.
  private recordFillFailure(milestoneId: string, message: string): void {
    console.error(
      `dispatchd: milestone dispatch fill failed for ${milestoneId}: ${message}`
    );
    try {
      this.appendMilestoneActivity(
        milestoneId,
        `[hook error] auto-dispatch failed: ${message}`,
        'none'
      );
    } catch {
      // Even the Activity append failing must not propagate — same rule
      // invokeHooksSafely applies to its own bookkeeping.
    }
  }

  // An automatic pause: a ceiling reached, or a fill that kept failing. The
  // Activity line carries the numbers, and `milestone.paused` carries them to
  // every client so the toast needs no fetch. Never used for a human's
  // pause — that one has no event.
  private pauseFor(
    milestoneId: string,
    reason: Exclude<MilestonePauseReason, 'human'>,
    detail?: string
  ): void {
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'active') return;
    session.state = 'paused';
    session.pausedReason = reason;
    if (detail !== undefined) session.pausedDetail = detail;
    else delete session.pausedDetail;
    session.updatedAt = new Date().toISOString();
    this.clearFillRetry(milestoneId);
    const spend = this.sessionSpend(milestoneId, session);
    const why =
      reason === 'budget'
        ? `spend ceiling reached (${formatUsd(spend.settledUsd)} settled + ~${formatUsd(spend.estimatedLiveUsd)} in flight of ${formatUsd(spend.maxSpendUsd ?? 0)})`
        : reason === 'runs'
          ? `run ceiling reached (${spend.runsStarted}/${spend.maxRuns ?? 0} runs)`
          : `auto-dispatch kept failing: ${detail ?? ''}`;
    try {
      this.appendMilestoneActivity(
        milestoneId,
        `milestone dispatch paused — ${why}`,
        'none'
      );
    } catch {
      // A pause reached from a failing fill may fail to append for the same
      // reason the fill did; the record and the event still carry it.
    }
    this.persist();
    this.emitChanged(milestoneId);
    this.ctx.events.broadcast({
      type: 'milestone.paused',
      milestoneId,
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
    milestoneId: string,
    session: MilestoneSessionRecord,
    estimate = loadConfig(this.ctx.rootDir).orchestrator.runCostEstimateUsd,
    childIds: ReadonlySet<string> = new Set(
      this.scopeOf(milestoneId).map((c) => c.meta.id)
    )
  ): MilestoneSpend {
    return deriveSpend(
      this.ctx.orchestrator.list().filter((r) => childIds.has(r.taskId)),
      session.startedAt,
      estimate,
      { maxSpendUsd: session.maxSpendUsd, maxRuns: session.maxRuns }
    );
  }

  // Dispatches ready work in the session's scope (the tasks the Flight Plan
  // draws, see scopeOf) via startReady: concurrency cap, then the run and
  // spend ceilings, no two overlapping `writes` started in one pass. Every
  // ready task left unstarted is told why (noteFillHolds).
  // A teammate's task is never a candidate, and holds its dependents until it
  // is done (core's releasesFanoutDependents). Readiness runs over the FULL
  // task set first, since dispatchableTasks treats a blocker it wasn't given
  // as satisfied — a blocker in another milestone, or in none, must still count.
  // The ceilings are only consulted once there is something to gate, so a
  // session never pauses with nothing to dispatch.
  private async fillQueue(milestoneId: string): Promise<void> {
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'active' || !this.armed.has(milestoneId)) return;

    const scope = this.scopeOf(milestoneId);
    const work = this.ownWork(milestoneId, scope, this.cacheLookup());
    const workIds = new Set(work.map((c) => c.meta.id));
    const runs = this.ctx.orchestrator.list();
    const liveCount = runs.filter(
      (r) => workIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
    ).length;
    let slots = session.concurrency - liveCount;

    const tasks = this.ctx.cache.query({ includeArchived: true });
    const statuses = statusModelFor(this.ctx.rootDir);
    const { dispatcher, holder } = this.holderFor(session);
    const mine = new Set(
      work.filter((t) => holder(t) === null).map((t) => t.meta.id)
    );
    const byId = new Map(tasks.map((t) => [t.meta.id, t]));
    const finished = tasksWithFinishedRun(runs);
    const blocker = blockerView(holder, tasksWithRunBranch(runs), finished);
    const waitingOn = (t: TaskDoc) =>
      fanoutWaitingOn(t, (id) => byId.get(id), statuses, blocker);
    this.noteWatched(milestoneId, work, mine, statuses, waitingOn);
    // The scope includes archived children (see scopeOf); dispatchability
    // must exclude them explicitly. dispatchableTasks releases a dependent at
    // a blocker's review role; a fan-out also wants a branch to stack on.
    const candidates = dispatchableTasks(tasks, statuses, (id) =>
      finished.has(id)
    ).filter(
      (t) =>
        mine.has(t.meta.id) &&
        t.meta.archivedAt === undefined &&
        !this.holdCritical(session, milestoneId, t)
    );
    // Every candidate this pass leaves unstarted gets a reason (see
    // noteFillHold), so a session that stops filling always says why.
    const holds = new Map<string, string>();
    const ready: TaskDoc[] = [];
    for (const t of candidates) {
      const waiting = waitingOn(t);
      if (waiting.length === 0) ready.push(t);
      else holds.set(t.meta.id, `waiting on ${waiting.join(', ')}`);
    }
    // A live run's footprint can have grown past its task's declared writes
    // (see Orchestrator.liveClaims) — a newly-ready task must avoid that too.
    const liveClaims = this.ctx.orchestrator.liveClaims();
    // An undeclared task (`writes: []`) therefore waits on ANY live claim until
    // that run goes terminal — nothing reaps one, so a parked run waits on a human.
    const clearOfLiveRuns: TaskDoc[] = [];
    for (const t of ready) {
      const blocking = liveClaims.find((c) =>
        claimConflictsWithWrites(c.claims, t.meta.writes)
      );
      if (blocking === undefined) clearOfLiveRuns.push(t);
      else {
        holds.set(
          t.meta.id,
          `waiting for live run ${blocking.runId} to finish with the files it touches`
        );
      }
    }
    const started = await this.startReady(
      session,
      milestoneId,
      scope,
      clearOfLiveRuns,
      slots,
      liveCount,
      holds,
      holder,
      dispatcher,
      statuses
    );
    this.noteFillHolds(milestoneId, holds);
    if (started > 0) this.emitChanged(milestoneId);
  }

  // fillQueue's dispatch step: starts tasks from `ready` in order until the
  // free slots are used, and records in `holds` why each one left behind was
  // not started. Tasks are tried one at a time rather than as a batch fixed
  // up front, so a refused dispatch hands its slot to the next task instead
  // of ending the pass. Undeclared tasks (`writes: []`) conflict with
  // everything, so before this a single refusal could stall a whole session
  // with nothing left to trigger another fill. Returns how many started.
  private async startReady(
    session: MilestoneSessionRecord,
    milestoneId: string,
    scope: readonly TaskListItem[],
    ready: readonly TaskDoc[],
    freeSlots: number,
    liveCount: number,
    holds: Map<string, string>,
    holder: (task: TaskListItem) => string | null,
    dispatcher: string,
    statuses: StatusModel
  ): Promise<number> {
    const waitForSlot = (from: number) => {
      for (const t of ready.slice(from)) {
        holds.set(
          t.meta.id,
          `waiting for a free slot (${session.concurrency} running at once)`
        );
      }
    };
    let slots = freeSlots;
    // A full session refills on its next terminal, which re-reads all this.
    if (slots <= 0) {
      waitForSlot(0);
      return 0;
    }
    if (ready.length === 0) return 0;

    if (session.maxRuns !== null || session.maxSpendUsd !== null) {
      // Read per pass, like the merge queue's verifyCommand, so a config edit
      // mid-session changes the next gate.
      const estimate = loadConfig(this.ctx.rootDir).orchestrator
        .runCostEstimateUsd;
      const spend = this.sessionSpend(
        milestoneId,
        session,
        estimate,
        new Set(scope.map((c) => c.meta.id))
      );
      if (session.maxRuns !== null) {
        slots = Math.min(slots, session.maxRuns - spend.runsStarted);
        // No future terminal can free a run, so this pause is final until
        // the human raises the ceiling.
        if (slots <= 0) {
          this.pauseFor(milestoneId, 'runs');
          return 0;
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
          if (liveCount === 0) this.pauseFor(milestoneId, 'budget');
          return 0;
        }
      }
    }

    // The orchestrator re-asks this of the task as it stands right before its
    // run registers: a Linear pull can hand it to a teammate mid-batch.
    const guard = (task: TaskDoc): string | null => {
      const heldBy = holder(task);
      if (heldBy !== null) return `assigned to ${heldBy}`;
      return isUnstartedStatus(task.meta.status, statuses)
        ? null
        : `status is now ${task.meta.status}`;
    };
    const startedTasks: TaskDoc[] = [];
    for (const [index, task] of ready.entries()) {
      if (startedTasks.length >= slots) {
        waitForSlot(index);
        break;
      }
      // No two overlapping `writes` in one pass (schedulableBatch's rule),
      // checked against the tasks that actually started.
      const overlap = startedTasks.find((t) =>
        tasksConflict(t.meta.writes, task.meta.writes)
      );
      if (overlap !== undefined) {
        // Worded without the other task's id, so a queue of undeclared tasks
        // taking turns writes this once per task rather than once per turn.
        holds.set(
          task.meta.id,
          task.meta.writes.length === 0
            ? 'queued: it declares no writes, so it runs only while no other task in this pass does'
            : 'queued behind a task started this pass that may write the same files'
        );
        continue;
      }
      // MEM-R8(b): the run acts for the session's operator only on a task
      // that operator created and last wrote.
      const operator =
        this.ctx.authorship === undefined
          ? null
          : this.ctx.authorship.actsFor(task, session.operator ?? null);
      try {
        // The milestone scheduler's own auto-fill decided this task was next —
        // no human pressed dispatch for it specifically, but the run is the
        // starter's work (a legacy session's, the local human's). Through
        // dispatchOrResume, not dispatch: a task whose last run a restart left
        // recoverable must be picked back up here too, since a fresh run would
        // strand that worktree and cancel the sweep still watching it.
        await this.ctx.orchestrator.dispatchOrResume(task.meta.id, {
          executor: session.executor,
          actor: 'none',
          operator,
          dispatchedBy: dispatcher,
          guard,
        });
        startedTasks.push(task);
      } catch (err) {
        // A task that already picked up a live run outside this session, that
        // the guard refused (raced between the readiness snapshot and here),
        // or whose base could not be built is skipped, with the refusal as
        // its reason, and its slot goes to the next task.
        if (!(err instanceof OrchestratorConflictError)) throw err;
        holds.set(task.meta.id, `not started: ${err.message}`);
      }
    }
    return startedTasks.length;
  }

  // Writes why each task in `holds` was left unstarted to the milestone's
  // Activity and to the task itself, once per distinct reason (the same
  // write-once rule holdCritical follows), and forgets tasks that are no
  // longer held so a later hold is reported afresh.
  private noteFillHolds(
    milestoneId: string,
    holds: ReadonlyMap<string, string>
  ): void {
    const previous = this.fillHolds.get(milestoneId) ?? new Map();
    for (const [taskId, reason] of holds) {
      if (previous.get(taskId) === reason) continue;
      try {
        this.appendMilestoneActivity(
          milestoneId,
          `${taskId} not dispatched — ${reason}`,
          'none'
        );
        this.appendTaskActivity(
          taskId,
          `milestone ${milestoneId} did not dispatch this task — ${reason}`
        );
      } catch (err) {
        // Reporting a hold must not break the fill that found it.
        console.error(
          `dispatchd: failed to record a fill hold on ${taskId}: ${(err as Error).message}`
        );
      }
    }
    this.fillHolds.set(milestoneId, new Map(holds));
  }

  // One daemon-authored Activity line on a task.
  private appendTaskActivity(taskId: string, text: string): void {
    const now = new Date().toISOString();
    this.ctx.store.update(
      taskId,
      { appendActivity: `${now} ${text}`, activityActor: 'none' },
      now
    );
    this.ctx.cache.refresh(this.ctx.store, [taskId]);
    this.ctx.events.broadcast({ type: 'task.changed', ids: [taskId] });
  }

  // A critical-risk child (a publish, a release, a repo-settings change) is
  // never auto-dispatched: the autonomy ladder caps such a task at rung 1
  // (core/policy.ts RISK_RUNG_CAPS), and the milestone scheduler's own fill is an
  // auto-decision. It waits for a human to dispatch it by hand, and the hold
  // is written to the milestone's Activity once so it reads as a decision rather
  // than a child that silently never starts. Returns true when held.
  private holdCritical(
    session: MilestoneSessionRecord,
    milestoneId: string,
    task: TaskDoc
  ): boolean {
    if (task.meta.risk !== 'critical') return false;
    if (!session.heldCritical.has(task.meta.id)) {
      session.heldCritical.add(task.meta.id);
      this.persist();
      this.appendMilestoneActivity(
        milestoneId,
        `holding ${task.meta.id} for explicit human dispatch — critical-risk work is never auto-dispatched`,
        'none'
      );
    }
    return true;
  }

  // True once none of a milestone's children is still pending work: nothing sits
  // at `ready` (unstarted, whether or not it's currently dispatchable) or
  // `working`, no child has a run still live (a review or verify run on a
  // child parked at `review` is still this session's work), and no child's
  // fix loop is mid-round. This deliberately does NOT wait for a human review
  // action (merge/discard/PR) to flip a task all the way to `landed`; the
  // milestone's own dispatch work is done once nothing is left running or
  // runnable. A session with only capped loops left stays active — those
  // wait on a ruling, which is the human's queue. A milestone with zero children
  // never "completes" on its own (there is nothing to wait on, but also
  // nothing accomplished). A teammate's task is theirs to finish: only the
  // session's own work waiting on it keeps the session open.
  private isMilestoneComplete(milestoneId: string): boolean {
    const scope = this.scopeOf(milestoneId);
    if (scope.length === 0) return false;
    const children = this.ownWork(milestoneId, scope, this.cacheLookup());
    const statuses = statusModelFor(this.ctx.rootDir);
    const { holder } = this.holderFor(this.sessions.get(milestoneId));
    const runs = this.ctx.orchestrator.list();
    // A child in a review status shared with dispatched is waiting for review
    // once its run finished, not still working.
    const finished = tasksWithFinishedRun(runs);
    if (
      children.some(
        (c) =>
          holder(c) === null &&
          (isUnstartedStatus(c.meta.status, statuses) ||
            (hasStatusRole(c.meta.status, 'dispatched', statuses) &&
              !isReviewStatus(
                c.meta.status,
                statuses,
                finished.has(c.meta.id)
              )))
      )
    ) {
      return false;
    }
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveRun = runs.some(
      (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
    );
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

  private completeMilestone(milestoneId: string): void {
    const session = this.sessions.get(milestoneId);
    if (session?.state !== 'active') return;
    const now = new Date().toISOString();
    session.state = 'complete';
    session.completedAt = now;
    session.updatedAt = now;
    this.armed.delete(milestoneId);
    this.watching.delete(milestoneId);
    this.clearFillRetry(milestoneId);
    this.appendMilestoneActivity(
      milestoneId,
      'milestone dispatch session ended — no children left to dispatch',
      'none'
    );
    this.persist();
    this.emitChanged(milestoneId);
  }

  // The tasks `milestoneId`'s fan-out covers (core's fanoutScope): exactly what
  // its Flight Plan draws, a project's milestone issues included — unless a
  // live session keeps the direct-children rule it was started under.
  // Includes archived ones: progress/completeness are historical facts about
  // the milestone, and an archived child is done+pushed, not missing.
  // Walks the cache unless given a board's `childrenOf` (progress reads
  // body-less items).
  private scopeOf(
    milestoneId: string,
    childrenOf?: undefined,
    rule?: MilestoneSessionScope
  ): TaskDoc[];
  private scopeOf<T extends TaskListItem>(
    milestoneId: string,
    childrenOf: (id: string) => readonly T[],
    rule?: MilestoneSessionScope
  ): T[];
  private scopeOf(
    milestoneId: string,
    childrenOf: (id: string) => readonly TaskListItem[] = (id) =>
      this.ctx.cache.query({ parent: id, includeArchived: true }),
    rule: MilestoneSessionScope = this.scopeRuleOf(milestoneId)
  ): TaskListItem[] {
    return rule === 'direct'
      ? childrenOf(milestoneId).filter((t) => !isContainerKind(t.meta.kind))
      : fanoutScope(milestoneId, childrenOf);
  }

  // A live session's scope rule; `plan` for any fan-out yet to start.
  private scopeRuleOf(milestoneId: string): MilestoneSessionScope {
    const session = this.sessions.get(milestoneId);
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
    milestoneId: string,
    scope: TaskDoc[],
    lookup: (id: string) => TaskDoc | null | undefined
  ): TaskDoc[] {
    const liveSession = (id: string): boolean => {
      const session = this.sessions.get(id);
      return session !== undefined && isLive(session);
    };
    if (
      ![...this.sessions.keys()].some(
        (id) => id !== milestoneId && liveSession(id)
      )
    ) {
      return scope;
    }
    return scope.filter(
      (task) => fanoutCoverers(task, lookup).find(liveSession) === milestoneId
    );
  }

  // One fan-out per task: refuses a start whose scope shares a task with
  // another active or paused session, such as a project's and one of its
  // milestones'.
  private refuseOverlap(milestoneId: string): void {
    let mine: ReadonlySet<string> | null = null;
    for (const [otherId, other] of this.sessions) {
      if (otherId === milestoneId || !isLive(other)) continue;
      mine ??= new Set(
        this.scopeOf(milestoneId, undefined, 'plan').map((t) => t.meta.id)
      );
      const scope = mine;
      const shared = this.scopeOf(otherId).filter((t) =>
        scope.has(t.meta.id)
      ).length;
      if (shared > 0) {
        throw new OrchestratorConflictError(
          `fan-out would overlap ${otherId}'s ${other.state} session on ${shared} task(s) — stop that one first: ${milestoneId}`
        );
      }
    }
  }

  // Who holds a task against `session` (core's fanoutHolder): the teammate
  // it belongs to, or null when the session may start it. Without a session,
  // the local human's view.
  private holderFor(session: MilestoneSessionRecord | undefined): {
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
    milestoneId: string,
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
    this.watching.set(milestoneId, watched);
  }

  // Work can free up outside any run: a teammate's issue landing through
  // Linear, a hand edit, or a teammate handing their task back. Runs fire
  // onRunTerminal; this catches the rest, refilling a session only when a
  // blocker it waited on now lets go or a task it held back is now its own.
  private onTasksChanged(ids: readonly string[] | undefined): void {
    let statuses: StatusModel | null = null;
    let withRunBranch: Set<string> | null = null;
    let finished: Set<string> | null = null;
    for (const [milestoneId, { waiting, held }] of this.watching) {
      if (!this.armed.has(milestoneId)) continue;
      const session = this.sessions.get(milestoneId);
      if (session?.state !== 'active') continue;
      const touched = (set: ReadonlySet<string>) =>
        ids === undefined ? [...set] : ids.filter((id) => set.has(id));
      const blockers = touched(waiting);
      const holding = touched(held);
      if (blockers.length === 0 && holding.length === 0) continue;
      statuses ??= statusModelFor(this.ctx.rootDir);
      if (withRunBranch === null || finished === null) {
        const runs = this.ctx.orchestrator.list();
        withRunBranch = tasksWithRunBranch(runs);
        finished = tasksWithFinishedRun(runs);
      }
      const model = statuses;
      const { holder } = this.holderFor(session);
      const view = blockerView(holder, withRunBranch, finished);
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
      if (released || handedBack) this.scheduleFill(milestoneId);
    }
  }

  private requireMilestone(milestoneId: string): TaskDoc {
    const milestone = this.ctx.store.get(milestoneId);
    if (milestone === null) {
      throw new OrchestratorNotFoundError(
        `milestone not found: ${milestoneId}`
      );
    }
    if (
      !isContainerKind(milestone.meta.kind) &&
      !this.ctx.cache.isContainer(milestoneId)
    ) {
      throw new OrchestratorClientError(`not a container: ${milestoneId}`);
    }
    return milestone;
  }

  private validateConcurrency(value: number, maxConcurrency: number): number {
    if (!Number.isInteger(value) || value < 1 || value > maxConcurrency) {
      throw new OrchestratorClientError(
        `invalid concurrency: ${String(value)} (expected an integer between 1 and ${maxConcurrency}, the configured orchestrator.maxConcurrency)`
      );
    }
    return value;
  }

  // `actor` credits who caused this milestone-level Activity line: omitted
  // defaults to the daemon's human (start()/pause()/resume()/stop() are all
  // only ever reached through the API), while a mechanical line (an
  // auto-fill completing, a ceiling pause, a hook error) passes 'none'
  // explicitly at its own call site.
  private appendMilestoneActivity(
    milestoneId: string,
    text: string,
    actor?: string
  ): void {
    const now = new Date().toISOString();
    this.ctx.store.update(
      milestoneId,
      {
        appendActivity: `${now} [milestone] ${text}`,
        activityActor: actor ?? this.ctx.actorContext?.humanRef,
      },
      now
    );
    this.ctx.cache.refresh(this.ctx.store, [milestoneId]);
    this.ctx.events.broadcast({ type: 'task.changed', ids: [milestoneId] });
  }

  // The `milestone.changed` refetch signal, debounced per milestone on a trailing
  // timer so a wave's terminal storm is one refetch. A window of 0 (the test
  // seam) broadcasts synchronously.
  private emitChanged(milestoneId: string): void {
    if (this.eventDebounceMs === 0) {
      this.ctx.events.broadcast({ type: 'milestone.changed', milestoneId });
      return;
    }
    clearTimeout(this.changedTimers.get(milestoneId));
    const timer = setTimeout(() => {
      this.changedTimers.delete(milestoneId);
      this.ctx.events.broadcast({ type: 'milestone.changed', milestoneId });
    }, this.eventDebounceMs);
    timer.unref?.();
    this.changedTimers.set(milestoneId, timer);
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
      for (const [milestoneId, session] of this.sessions) {
        sessions[milestoneId] = {
          ...session,
          heldCritical: [...session.heldCritical],
        };
      }
      const snapshot: MilestoneSessionsSnapshot = { version: 1, sessions };
      writeFileSync(
        milestoneSessionsPath(this.ctx.rootDir),
        `${JSON.stringify(snapshot)}\n`
      );
    } catch (err) {
      console.error(
        `dispatchd: failed to persist milestone sessions: ${(err as Error).message}`
      );
    }
  }

  // Lenient read of the persisted file: a missing or corrupt file starts
  // empty and logs once, and an entry whose state is not one of the four (or
  // is missing the fields a fill needs) is dropped rather than trusted. Every
  // hydrated `active` session starts unarmed — resumeOnBoot() arms it.
  private hydrate(): void {
    const path = milestoneSessionsPath(this.ctx.rootDir);
    if (!existsSync(path)) return;
    let parsed: Partial<MilestoneSessionsSnapshot>;
    try {
      parsed = JSON.parse(
        readFileSync(path, 'utf8')
      ) as Partial<MilestoneSessionsSnapshot>;
    } catch (err) {
      console.error(
        `dispatchd: failed to read milestone sessions, starting empty: ${(err as Error).message}`
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
    for (const [milestoneId, raw] of Object.entries(sessions)) {
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
      this.sessions.set(milestoneId, {
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
    milestoneId: string,
    session: MilestoneSessionRecord
  ): MilestoneSession {
    return {
      milestoneId,
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
