import {
  DISPATCH_DIR,
  generateRunId,
  loadConfig,
  slugify,
  TaskParseError,
  TaskStore,
} from '@dispatch/core';
import type {
  ActorContext,
  CommandEvidence,
  MutationEvidence,
  OrchestratorConfig,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import { FindingStore } from '../findings.js';
import { GitRepo } from '../git/commands.js';
import { LedgerStore } from '../ledger.js';
import { dirSizeBytes } from './dirSize.js';
import { JjManager } from './jj.js';
import { collectOrientation } from './orientation.js';
import type { RepoOrientation } from './orientation.js';
import {
  diffSnapshotPath,
  runsDir,
  transcriptPath,
  worktreePath,
  worktreesDir,
} from './paths.js';
import {
  buildTaskPrompt,
  renderSurveySection,
  untrustedInline,
} from './prompt.js';
import { RunRegistry } from './registry.js';
import { RepoDigestCache } from './repoDigest.js';
import type { RunDetail } from './transcript.js';
import { replayTranscript, Transcript } from './transcript.js';
import type {
  ApprovalDecision,
  BranchEntry,
  BranchEntryStatus,
  Executor,
  ExecutorEvents,
  ExecutorStartOptions,
  NormalizedEntry,
  RunKind,
  RunMeta,
  RunState,
  RunSurvey,
} from './types.js';
import {
  MergeEnvironmentError,
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  runKind,
  TERMINAL_RUN_STATES,
} from './types.js';
import type { DiffResult } from './worktree.js';
import { WorktreeManager } from './worktree.js';

export interface OrchestratorContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  // Optional override for the 2+-blocker stacked-dispatch path — the only
  // path that mutates the user's actual repository. Production never passes
  // it (a real JjManager is built below); tests inject one wired to a stub
  // CommandRunner so that path can be exercised without a jj binary, which is
  // otherwise structurally untestable.
  jj?: JjManager;
  // Ledger entries injected into dispatch prompts (see promptForTask below).
  // Defaults to one over `rootDir`, same pattern as `jj`.
  ledgerStore?: LedgerStore;
  // Where blocking rulings are read from (see blockedFindingReason). Defaults
  // to one over `rootDir`, same pattern as `ledgerStore`.
  findingStore?: FindingStore;
  // Who to credit on an Activity line when a call site doesn't say so itself
  // (see the `actor` opts on dispatch/review/sendMessage below). Optional —
  // a test that omits it gets the pre-attribution behavior (an unattributed
  // Activity line), same as an UpdatePatch that never sets `activityActor`.
  // Production (index.ts) always supplies the one resolved at daemon boot.
  actorContext?: ActorContext;
  // Overrides CLAIMS_REFRESH_COOLDOWN_MS — test-injection seam only, so a
  // cooldown test isn't stuck waiting out the real 5s production window.
  claimsRefreshCooldownMs?: number;
  // Overrides STOP_ESCALATION_MS, same test-injection reason: a test proving a
  // stubborn run gets escalated cannot wait out the real two-minute window.
  stopEscalationMs?: number;
  // The repo-map cache injected into run prompts (see promptForTask). Defaults
  // to one over `rootDir`, same pattern as `ledgerStore`. A test that wants no
  // model call at all can pass one built with a stubbed generator.
  digestCache?: RepoDigestCache;
}

// The name api.ts's createRun falls back to when a caller omits `executor`
// entirely — also the first name requestChanges() tries when a run's
// original executor is no longer registered on this daemon (see
// resolveExecutorForResume below), since that's overwhelmingly the common
// case (a run created with a dev-only executor, now being resumed under a
// daemon that only has the real one).
const DEFAULT_EXECUTOR_NAME = 'claude';

// The ref namespace every run's branch is created under (see dispatch()) and
// the prefix listBranches() enumerates. Kept as one constant so the writer and
// the reader can never drift — a mismatch would make every dispatch branch
// invisible to the Branches surface.
const DISPATCH_BRANCH_PREFIX = 'dispatch/';

// Minimum gap between opportunistic claims refreshes for one run — see
// scheduleClaimsRefresh.
const CLAIMS_REFRESH_COOLDOWN_MS = 5_000;

// How long a gracefully-stopped run gets to wind down before the stop is
// escalated to a hard cancel — see scheduleStopEscalation. Generous on purpose:
// the agent may legitimately be mid-tool-call (a long test run, a large edit)
// when Stop is pressed, and that call is exactly what a graceful stop promises
// not to abort. It only has to stop starting NEW work, which it learns about at
// its next tool call.
const STOP_ESCALATION_MS = 120_000;

// Sort order for the Branches surface: the rows that need a human decision
// come first, read-only live runs last.
const STATUS_RANK: Record<BranchEntryStatus, number> = {
  leftover: 0,
  orphan: 1,
  reviewable: 2,
  active: 3,
};

// How a branch ref relates to the run registry — see BranchEntryStatus for
// what each value means. A branch with no run at all is an orphan; otherwise
// the run's own lifecycle decides.
function branchEntryStatus(meta: RunMeta | undefined): BranchEntryStatus {
  if (meta === undefined) return 'orphan';
  if (!TERMINAL_RUN_STATES.has(meta.state)) return 'active';
  return meta.reviewedAt === undefined ? 'reviewable' : 'leftover';
}

/**
 * Coordinates the full lifecycle of orchestrator runs for one dispatch
 * project: provisioning a git worktree, starting an Executor, recording its
 * NormalizedEntry stream + state transitions to a per-run transcript, and
 * applying the resulting Task Activity/status writes the plan requires.
 *
 * The registry (in-memory) is the fast path for anything about a live or
 * recently-created run; transcripts on disk are the durable record that
 * survives a dispatchd restart (see `reconcileOnBoot` and `getRun`'s
 * fallback path).
 */
export class Orchestrator {
  private readonly registry = new RunRegistry();
  // In-flight scheduled surveys, keyed by run — see surveySettled().
  private readonly scheduledSurveys = new Map<string, Promise<void>>();
  private readonly worktrees: WorktreeManager;
  // Only ever used on the multi-blocker dispatch path (see resolveBase):
  // constructing it is inert — it shells out to jj lazily, per call — so an
  // unblocked dispatch never touches jj at all.
  private readonly jj: JjManager;
  private readonly ledgerStore: LedgerStore;
  private readonly findingStore: FindingStore;
  // The repo map injected into every run prompt (see promptForTask). Held on
  // the orchestrator rather than built per dispatch so its single-flight
  // background refresh really is one refresh, not one per concurrent dispatch.
  private readonly digestCache: RepoDigestCache;
  private readonly executors = new Map<string, Executor>();
  // Phase 5 P1: callbacks fired exactly once per run, right after it reaches
  // a terminal state AND every bit of bookkeeping that goes with that
  // (task status, Activity) has already landed — see fireTerminalHooks()'s
  // call sites in handleFinish()/cancel(). The epic dispatch engine is the
  // one production subscriber today.
  private readonly terminalHooks: Array<(meta: RunMeta) => void> = [];
  // Phase 5 P1: callbacks fired whenever a run is reviewed — merge, discard,
  // or (via markRunMergedViaPr) a merged PR — i.e. whenever a task might
  // have just moved to `done`. A run reaching a terminal state (finished/
  // failed/cancelled) only ever leaves its task at `in-review`
  // (handleFinish); readyTasks() in @dispatch/core gates on a blocker being
  // `done`/`cancelled`, so the epic engine needs this *second* seam — not
  // just onRunTerminal above — to know when a blocked sibling has actually
  // become dispatchable, since that only happens once a review action runs.
  private readonly reviewedHooks: Array<(meta: RunMeta) => void> = [];
  // When each run's claims were last refreshed from git status — see
  // scheduleClaimsRefresh's cooldown check.
  private readonly lastClaimsCheck = new Map<string, number>();
  private readonly claimsRefreshCooldownMs: number;
  // Pending "this stop has taken too long" timers, keyed by run — see
  // scheduleStopEscalation, and transition() for where they are cleared.
  private readonly stopEscalations = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly stopEscalationMs: number;

  constructor(private readonly ctx: OrchestratorContext) {
    this.worktrees = new WorktreeManager(ctx.rootDir);
    this.jj = ctx.jj ?? new JjManager(ctx.rootDir);
    this.ledgerStore = ctx.ledgerStore ?? new LedgerStore(ctx.rootDir);
    this.findingStore = ctx.findingStore ?? new FindingStore(ctx.rootDir);
    this.digestCache = ctx.digestCache ?? new RepoDigestCache(ctx.rootDir);
    this.claimsRefreshCooldownMs =
      ctx.claimsRefreshCooldownMs ?? CLAIMS_REFRESH_COOLDOWN_MS;
    this.stopEscalationMs = ctx.stopEscalationMs ?? STOP_ESCALATION_MS;
  }

  // Subscribes to "a run just reached a terminal state" — provisioning ->
  // running -> finished/failed/cancelled, exactly once per run. Returns an
  // unsubscribe function. This is the clean, push-based seam the epic engine
  // uses to know when a concurrency slot has freed up instead of polling
  // run state on a timer.
  onRunTerminal(callback: (meta: RunMeta) => void): () => void {
    this.terminalHooks.push(callback);
    return () => {
      const idx = this.terminalHooks.indexOf(callback);
      if (idx !== -1) this.terminalHooks.splice(idx, 1);
    };
  }

  // Subscribes to "a run was just reviewed" — merge, discard, or a merged
  // PR (see the reviewedHooks field comment for why this exists alongside
  // onRunTerminal). Same unsubscribe-function shape.
  onRunReviewed(callback: (meta: RunMeta) => void): () => void {
    this.reviewedHooks.push(callback);
    return () => {
      const idx = this.reviewedHooks.indexOf(callback);
      if (idx !== -1) this.reviewedHooks.splice(idx, 1);
    };
  }

  registerExecutor(name: string, executor: Executor): void {
    this.executors.set(name, executor);
  }

  // M6: api.ts derives its own "is this executor name even valid" 400
  // message from exactly what's registered here, instead of maintaining a
  // separately hardcoded list that can silently drift from it.
  registeredExecutorNames(): string[] {
    return [...this.executors.keys()];
  }

  list(): RunMeta[] {
    return this.registry.list();
  }

  // Every live run's current claims, for GET /api/runs/claims and the epic
  // scheduler. A terminal run holds no claims — see TERMINAL_RUN_STATES.
  liveClaims(): { runId: string; taskId: string; claims: string[] }[] {
    return this.registry
      .list()
      .filter((r) => !TERMINAL_RUN_STATES.has(r.state))
      .map((r) => ({ runId: r.id, taskId: r.taskId, claims: r.claims ?? [] }));
  }

  // Adds `pushedToOrigin` to each merged run, computed fresh per request (never
  // persisted). Memoizes by (mergeCommit, baseBranch) so runs sharing a base pay once.
  decorateRunsWithPushed(
    runs: RunMeta[]
  ): (RunMeta & { pushedToOrigin?: boolean })[] {
    const hasOrigin = this.worktrees.hasOriginRemote();
    const cache = new Map<string, boolean>();
    return runs.map((run) => {
      if (run.reviewAction !== 'merge' || run.mergeCommit === undefined) {
        return run;
      }
      if (!hasOrigin) return { ...run, pushedToOrigin: false };
      const key = `${run.mergeCommit}\0${run.baseBranch}`;
      let pushed = cache.get(key);
      if (pushed === undefined) {
        pushed = this.worktrees.isOnOriginBase(run.mergeCommit, run.baseBranch);
        cache.set(key, pushed);
      }
      return { ...run, pushedToOrigin: pushed };
    });
  }

  // Thin passthroughs so MergeQueue can gate its own push-retry/auto-refresh
  // logic without reaching into WorktreeManager directly (same "queue must
  // not reach into either directly" rule the restack seam above documents).
  hasOriginRemote(): boolean {
    return this.worktrees.hasOriginRemote();
  }

  defaultBaseBranch(): string {
    return this.worktrees.defaultBaseBranch();
  }

  // Live runs (and anything hydrated by reconcileOnBoot) come straight from
  // the in-memory registry; a run this process has never seen — the same
  // rootDir after a restart with no reconciliation yet — falls back to
  // replaying its transcript file directly, since that's the only place its
  // state still exists.
  getRun(id: string): RunDetail | null {
    const meta = this.registry.get(id);
    if (meta !== undefined) {
      const lines = this.transcriptFor(id).read();
      const entries = lines
        .filter((line) => line.type === 'entry')
        .map((line) => line.entry);
      const evidence = lines
        .filter((line) => line.type === 'evidence')
        .map((line) => line.evidence);
      const mutations = lines
        .filter((line) => line.type === 'mutation')
        .map((line) => line.mutation);
      return { meta, entries, evidence, mutations };
    }
    return replayTranscript(transcriptPath(this.ctx.rootDir, id));
  }

  // Starts a new run for `taskId` on `executorName`. Refuses (409) if the
  // task already has a live run, and (400) if the executor name isn't
  // registered — O1 only ever registers 'fake'; 'claude' arrives in O2.
  async dispatch(
    taskId: string,
    executorName: string,
    // `actor` credits who caused this dispatch: omitted (the API's manual
    // dispatch) defaults to the daemon's human, but an automatic caller
    // (EpicEngine's auto-fill) passes 'none' explicitly — no human pressed
    // dispatch for that specific task.
    opts: { model?: string; actor?: string } = {}
  ): Promise<RunMeta> {
    const task = this.ctx.store.get(taskId);
    if (task === null) {
      throw new OrchestratorNotFoundError(`task not found: ${taskId}`);
    }
    const live = this.registry.liveRunForTask(taskId);
    if (live !== undefined) {
      throw new OrchestratorConflictError(
        `task already has a live run: ${live.id}`
      );
    }
    const executor = this.executors.get(executorName);
    if (executor === undefined) {
      throw new OrchestratorClientError(`unknown executor: ${executorName}`);
    }

    const { base: baseBranch, stackParents } = await this.resolveBase(task);
    const now = new Date().toISOString();
    const runId = generateRunId(now);
    // Suffixed with the run's own hex tag (stripping its `r-` prefix) so two
    // runs against the same task never collide on branch name — a task can
    // have several finished-but-unreviewed runs sitting in parallel until
    // each is merged/discarded, each keeping its own worktree/branch until
    // then. `sendMessage(..., { resume: true })` intentionally reuses the
    // *same* branch/worktree instead of generating a new one here.
    const branch = `${DISPATCH_BRANCH_PREFIX}${taskId}-${slugify(task.meta.title)}-${runId.slice(2)}`;
    const wtPath = worktreePath(this.ctx.rootDir, runId);

    this.worktrees.add(wtPath, branch, baseBranch);

    const meta: RunMeta = {
      id: runId,
      taskId,
      taskTitle: task.meta.title,
      executor: executorName,
      state: 'provisioning',
      branch,
      baseBranch,
      worktreePath: wtPath,
      createdAt: now,
      updatedAt: now,
      model: opts.model,
      // Seeded from the task's own declared write-set — see RunMeta.claims.
      claims: [...task.meta.writes],
      // Spread in only for a genuinely stacked run, so an unblocked run's
      // RunMeta keeps exactly the shape (and transcript header) it had
      // before stacking existed.
      ...(stackParents.length > 0
        ? {
            stackParents,
            stackBaseCommit: this.worktrees.resolveCommit(baseBranch),
          }
        : {}),
    };
    this.registry.create(meta);
    this.transcriptFor(runId).writeHeader(meta);

    this.ctx.store.update(
      taskId,
      {
        status: 'in-progress',
        appendActivity: `${now} dispatched (${executorName}, branch ${branch})`,
        activityActor: opts.actor ?? this.ctx.actorContext?.humanRef,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    this.transition(runId, 'running');
    const caps = this.orchestratorCaps();
    this.startAndRegister(
      runId,
      {
        cwd: wtPath,
        projectRoot: this.ctx.rootDir,
        runId,
        prompt: this.promptForTask(task),
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
        model: opts.model,
      },
      executor
    );

    return this.registry.get(runId)!;
  }

  // Starts a non-execute run against `head` on its own throwaway branch, and
  // leaves the task alone. `buildPrompt` runs once the worktree exists.
  dispatchAuxRun(opts: {
    taskId: string;
    kind: RunKind;
    head: string;
    executor?: string;
    model?: string;
    buildPrompt: (ctx: { runId: string; worktreePath: string }) => string;
  }): Promise<RunMeta> {
    const task = this.ctx.store.get(opts.taskId);
    if (task === null) {
      throw new OrchestratorNotFoundError(`task not found: ${opts.taskId}`);
    }
    const live = this.registry.liveRunForTask(opts.taskId);
    if (live !== undefined) {
      throw new OrchestratorConflictError(
        `task already has a live run: ${live.id}`
      );
    }
    const { executor, name: executorName } = this.resolveExecutorForResume(
      opts.executor ?? DEFAULT_EXECUTOR_NAME
    );

    const now = new Date().toISOString();
    const runId = generateRunId(now);
    const branch = `${DISPATCH_BRANCH_PREFIX}${opts.kind}-${opts.taskId}-${runId.slice(2)}`;
    const wtPath = worktreePath(this.ctx.rootDir, runId);
    this.worktrees.add(wtPath, branch, opts.head);

    const meta: RunMeta = {
      id: runId,
      taskId: opts.taskId,
      taskTitle: task.meta.title,
      executor: executorName,
      state: 'provisioning',
      branch,
      baseBranch: opts.head,
      worktreePath: wtPath,
      createdAt: now,
      updatedAt: now,
      model: opts.model,
      kind: opts.kind,
      claims: [...task.meta.writes],
    };
    this.registry.create(meta);
    this.transcriptFor(runId).writeHeader(meta);

    // A throwing buildPrompt would otherwise strand this run in `provisioning`,
    // which counts as live: the task could never be dispatched again.
    let prompt: string;
    try {
      prompt = opts.buildPrompt({ runId, worktreePath: wtPath });
    } catch (err) {
      const message = (err as Error).message;
      this.transition(runId, 'failed', {
        error: `failed to prepare ${opts.kind} run: ${message}`,
      });
      this.worktrees.remove(wtPath, branch, runId);
      throw new OrchestratorClientError(
        `failed to prepare ${opts.kind} run: ${message}`
      );
    }
    this.transition(runId, 'running');
    const caps = this.orchestratorCaps();
    this.startAndRegister(
      runId,
      {
        cwd: wtPath,
        projectRoot: this.ctx.rootDir,
        runId,
        prompt,
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
        model: opts.model,
      },
      executor
    );
    return Promise.resolve(this.registry.get(runId)!);
  }

  // Force-fails a non-execute run whose reported success a post-run check
  // rejected, bypassing transition()'s terminal guard on purpose.
  failAuxRun(runId: string, error: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined || runKind(meta) === 'execute') return;
    const now = new Date().toISOString();
    this.registry.updateMeta(runId, { state: 'failed', updatedAt: now, error });
    this.transcriptFor(runId).appendState('failed', now, { error });
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // Frees a finished non-execute run's throwaway worktree. Commits first (aux
  // agents can edit), and spares the branch if it holds commits the base lacks.
  cleanupAuxRun(runId: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined || runKind(meta) === 'execute') return;
    if (this.worktrees.isWorktreeDirty(meta.worktreePath)) {
      this.bestEffort(`auto-commit of aux run ${runId}`, () => {
        this.autoCommitIfDirty(meta.worktreePath, runId);
      });
    }
    if (this.worktrees.aheadCount(meta.branch, meta.baseBranch) > 0) {
      this.worktrees.removeWorktreeOnly(meta.worktreePath);
      this.bestEffort(`recording kept branch for run ${runId}`, () => {
        const now = new Date().toISOString();
        this.ctx.store.update(
          meta.taskId,
          {
            appendActivity: `${now} [run ${runId}] worktree removed; branch ${meta.branch} kept — it has unmerged commits`,
            // Mechanical cleanup of an aux run's worktree — no one asked for
            // this specific action, the daemon is just tidying up.
            activityActor: 'none',
          },
          now
        );
        this.ctx.cache.rebuild(this.ctx.store);
        this.ctx.events.broadcast({ type: 'task.changed' });
      });
      return;
    }
    this.worktrees.remove(meta.worktreePath, meta.branch, runId);
  }

  /**
   * The ref a task's worktree should be branched from. An unblocked task uses
   * the project's default base, exactly as before. A task whose blockers are
   * still unmerged is branched off *their* branches instead, so the agent can
   * see the work it depends on — that is the whole point of letting a
   * dependent start while its blocker is only `in-review`.
   *
   * Only `in-review` blockers matter here: a done/cancelled blocker's work is
   * already in the base branch, and an `in-progress` blocker means the task
   * isn't dispatchable at all (see core's dispatchableTasks).
   *
   * Two or more unmerged blockers need a base containing all of their work,
   * which only jj can express (`jj new -r A -r B`). When jj isn't available
   * there is no correct base to pick, so the dispatch is REFUSED (spec §4.6):
   * the task waits, exactly as it did before stacking existed, and is retried
   * on the next fill. Dispatching it against the default base instead would be
   * strictly worse than today's behavior — the agent would see neither
   * blocker's work, and with no `stackParents` recorded the run would never be
   * restacked and never be flagged.
   */
  private async resolveBase(
    task: TaskDoc
  ): Promise<{ base: string; stackParents: string[] }> {
    const defaultBase = this.worktrees.defaultBaseBranch();
    const parents: string[] = [];
    for (const blockerId of task.meta.blockedBy) {
      const blocker = this.ctx.store.get(blockerId);
      if (blocker === null || blocker.meta.status !== 'in-review') continue;
      const branch = this.branchForTask(blockerId);
      if (branch !== null) parents.push(branch);
    }

    if (parents.length === 0) return { base: defaultBase, stackParents: [] };
    if (parents.length === 1) {
      return { base: parents[0], stackParents: parents };
    }

    // Only reached with 2+ unmerged blockers — the one case that genuinely
    // needs jj, so converting the user's repo never happens for a dispatch
    // that could have been served by plain git.
    //
    // The jj calls are wrapped because this is the only part of dispatch that
    // shells out to a tool the user may not have, in a repo shape jj may
    // refuse: no jj failure may turn this into an opaque 500. Every failure
    // converges on the same outcome the jj-unavailable case takes — refuse,
    // and say why on the task — so the task simply waits (fillQueue skips an
    // OrchestratorConflictError and retries on the next pass; a manual
    // dispatch 409s with the reason).
    let base: string;
    try {
      const wasColocated = await this.jj.isColocated();
      if (!(await this.jj.ensureColocated())) {
        throw new Error('jj is unavailable');
      }
      if (!wasColocated) {
        // Converting a user's repo is never silent — §4.2 of the spec.
        this.noteTaskActivity(
          task.meta.id,
          'stacked dispatch: converted this repository to a colocated jj repo (reversible with `jj git colocation disable`)'
        );
      }
      const bookmark = `dispatch/stack-base-${task.meta.id}`;
      base = await this.jj.mergeBase(parents, bookmark);
    } catch (err) {
      const reason = `${parents.length} unmerged blockers need a multi-parent base, which only jj can build (${(err as Error).message}) — waiting until they merge`;
      // Once per distinct reason, not once per fill pass. A waiting task is
      // re-attempted on every pass for as long as its blockers stay unmerged,
      // and the old fallback wrote its line exactly once because it never
      // retried; an unbounded run of identical lines in the task file would be
      // pure noise. A reason that CHANGES (a different jj failure) is new
      // information and is recorded.
      this.noteTaskActivityOnce(task.meta.id, `stacked dispatch: ${reason}`);
      throw new OrchestratorConflictError(reason);
    }
    return { base, stackParents: parents };
  }

  // Appends one Activity line to a task, mirroring EpicEngine's
  // appendEpicActivity (epic.ts) so stack decisions leave the same durable
  // trail every other orchestrator lifecycle event does. Every caller
  // (stacked-dispatch jj bookkeeping, the merge queue's own restack notes via
  // appendRunTaskActivity) is the daemon narrating its own mechanics, not a
  // human or agent decision — so this always credits 'none'.
  private appendTaskActivity(taskId: string, text: string): void {
    const now = new Date().toISOString();
    this.ctx.store.update(
      taskId,
      { appendActivity: `${now} ${text}`, activityActor: 'none' },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  // The best-effort form of the above, for the paths that are already
  // reporting a failure: the note is context on something that went wrong, so
  // a second failure while writing it (a locked/unwritable task file) must not
  // replace the real error with an opaque 500. Same swallow-and-log rule
  // EpicEngine.recordFillFailure applies to its own Activity append.
  private noteTaskActivity(taskId: string, text: string): void {
    try {
      this.appendTaskActivity(taskId, text);
    } catch (err) {
      console.error(
        `dispatchd: failed to record activity on task ${taskId}: ${(err as Error).message}`
      );
    }
  }

  // noteTaskActivity for a condition that RECURS: skips the append when this
  // exact text is already somewhere in the task's body. Activity lines are
  // written as `<timestamp> <text>`, so the text alone is what identifies a
  // repeat. Reading the task can itself fail (a corrupt or unreadable file),
  // which must not be worse than a duplicate line — that case falls through to
  // appending.
  private noteTaskActivityOnce(taskId: string, text: string): void {
    try {
      if (this.ctx.store.get(taskId)?.body.includes(text) === true) return;
    } catch {
      // Fall through and append.
    }
    this.noteTaskActivity(taskId, text);
  }

  // The branch of a task's most recent terminal, unreviewed run — the branch
  // that actually holds its unmerged work. Returns null when the task has no
  // such run (never dispatched, or already merged/discarded), in which case
  // there is nothing to stack on.
  private branchForTask(taskId: string): string | null {
    const candidates = this.registry
      .list()
      .filter(
        (r) =>
          r.taskId === taskId &&
          TERMINAL_RUN_STATES.has(r.state) &&
          r.reviewedAt === undefined
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0]?.branch ?? null;
  }

  // Answers a pending approval request. Only valid while the run is
  // `awaiting-approval` and `requestId` matches the one it's actually
  // waiting on — both mismatches are 400s, not 404s, since the run itself
  // does exist.
  approve(
    runId: string,
    requestId: string,
    decision: ApprovalDecision | boolean
  ): void {
    // Accepts a bare boolean so the older two-argument callers keep working unchanged; a
    // decision object is the richer form the review UI sends.
    const resolved: ApprovalDecision =
      typeof decision === 'boolean' ? { allow: decision } : decision;
    const meta = this.requireRun(runId);
    if (meta.state !== 'awaiting-approval') {
      throw new OrchestratorClientError(
        `run is not awaiting approval: ${runId}`
      );
    }
    const pending = this.registry.getPendingApproval(runId);
    if (pending === undefined || pending.requestId !== requestId) {
      throw new OrchestratorClientError(
        `unknown approval request: ${requestId}`
      );
    }
    const executorRun = this.registry.getExecutorRun(runId);
    // The run's own state checks above already guarantee non-terminal here
    // (awaiting-approval) — a missing ExecutorRun at this point means the
    // executor that was supposed to be driving it is gone (the daemon that
    // started it died/restarted without this run ever reaching a terminal
    // state). healZombieRun marks it failed and throws a clear error instead
    // of this silently doing nothing.
    if (executorRun === undefined) {
      this.healZombieRun(meta);
    }
    this.registry.setPendingApproval(runId, undefined);
    executorRun.approve(requestId, resolved);
    this.transition(runId, 'running');
  }

  // `resume: true` is the request-changes path: valid on any run that has
  // come to rest with a resumable session, and re-dispatches into the *same*
  // worktree/branch rather than provisioning a new one. Otherwise this is a
  // plain mid-run message to a live run's executor.
  // `actor` (resume path only) credits who asked for the redispatch: omitted
  // (the API's chat composer) defaults to the daemon's human; FixLoop's own
  // automatic escalation passes 'none' explicitly — no one typed anything,
  // the loop just moved to its next round.
  sendMessage(
    runId: string,
    text: string,
    opts: { resume?: boolean; actor?: string } = {}
  ): RunMeta {
    const meta = this.requireRun(runId);

    if (opts.resume === true) {
      // A run must have stopped before it can be resumed — a live one takes
      // the plain mid-run message path below instead.
      if (!TERMINAL_RUN_STATES.has(meta.state)) {
        throw new OrchestratorClientError(`run is still live: ${runId}`);
      }
      // Deliberately keyed on the SESSION, not on `state === 'finished'`.
      // This gate used to admit only finished runs, which was indistinguish-
      // able from the session check for as long as every non-crash
      // termination was mislabelled `finished` (see ClaudeExecutor's
      // truncated-run detection). Now that a usage-limit stop is correctly
      // recorded as `failed`, keying on state would refuse to resume exactly
      // the runs that most need it — cut off mid-task with their work still
      // sitting on the branch. What makes a run resumable is having a session
      // to resume into; a failed run with no session id would start a brand
      // new agent while pretending to continue, so that still refuses.
      if (meta.sessionId === undefined || meta.sessionId === '') {
        throw new OrchestratorClientError(
          `run has no resumable session: ${runId}`
        );
      }
      // C2: a reviewed run's worktree/branch may already be gone (merge) or
      // intentionally abandoned (discard) — either way there is nothing left
      // to resume into, and resuming would either fail on a missing cwd or
      // silently resurrect a run the user already closed out.
      if (meta.reviewedAt !== undefined) {
        throw new OrchestratorConflictError(
          `run has already been reviewed: ${runId}`
        );
      }
      // Same one-live-run-per-task rule dispatch() enforces: a resume forks
      // a NEW run into the task's existing worktree, so two resumes racing
      // each other (double-Enter on the composer, a retry after a UI error)
      // would put two agents in the SAME worktree editing concurrently. The
      // first resume wins; every duplicate 409s here instead.
      const live = this.registry.liveRunForTask(meta.taskId);
      if (live !== undefined) {
        throw new OrchestratorConflictError(
          `task already has a live run: ${live.id}`
        );
      }
      this.requireNoOpenPr(meta);
      return this.requestChanges(
        meta,
        text,
        opts.actor ?? this.ctx.actorContext?.humanRef
      );
    }

    if (TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorClientError(`run is not live: ${runId}`);
    }
    const executorRun = this.registry.getExecutorRun(runId);
    // Same zombie self-heal as approve() above — the terminal-state check
    // just above guarantees `meta.state` is non-terminal here, so a missing
    // ExecutorRun means this run's executor died out from under it (an old
    // daemon process crashed, or this daemon's own dispatch() start() call
    // itself failed) rather than the run ever reaching a normal finish.
    if (executorRun === undefined) {
      this.healZombieRun(meta);
    }
    const entry: NormalizedEntry = {
      ts: new Date().toISOString(),
      kind: 'message',
      from: 'user',
      text,
    };
    this.transcriptFor(runId).appendEntry(entry);
    this.ctx.events.broadcast({ type: 'run.log', runId, entry });
    executorRun.send(text);
    return meta;
  }

  // Resolves the label a `from: 'agent'` message entry should carry —
  // the sender run's task title + id when `from.runId` names a run this
  // orchestrator still knows about (live or terminal-but-registered), or
  // an explicit `from.label` override, or the generic fallback that keeps
  // `agent_message`'s pre-identity behavior (and its existing API test's
  // exact prefix text) unchanged when the sender can't be resolved at all.
  private resolveSenderLabel(from?: { runId?: string; label?: string }): {
    fromLabel: string;
  } {
    if (from?.runId !== undefined) {
      const senderMeta = this.registry.get(from.runId);
      if (senderMeta !== undefined) {
        return {
          fromLabel: `${untrustedInline(senderMeta.taskTitle)} (${senderMeta.id})`,
        };
      }
    }
    if (from?.label !== undefined && from.label.trim() !== '') {
      return { fromLabel: untrustedInline(from.label) };
    }
    return { fromLabel: 'another agent' };
  }

  // The messaging half of agent collaboration (spec's `agent_message`):
  // injects a message from *another* agent into a live run's executor.
  // Distinct from sendMessage's human-authored channel — this one always
  // prefixes the text with the resolved SENDER's identity (see
  // resolveSenderLabel) so the receiving agent can tell who's talking, and
  // deliberately only accepts a run that's actively `running` (not
  // provisioning, not awaiting-approval, not terminal): every other state
  // 409s, since "another agent has something to say right now" is only
  // unambiguous while the run is actually running. `resume`-style
  // reactivation is sendMessage's job, not this one's.
  inject(
    runId: string,
    text: string,
    from?: { runId?: string; label?: string }
  ): RunMeta {
    const meta = this.requireRun(runId);
    if (meta.state !== 'running') {
      throw new OrchestratorConflictError(`run is not running: ${runId}`);
    }
    const executorRun = this.registry.getExecutorRun(runId);
    // Same zombie self-heal as approve()/sendMessage() above — the state
    // check just above guarantees `meta.state === 'running'` here, so a
    // missing ExecutorRun means the executor died out from under a live run.
    if (executorRun === undefined) {
      this.healZombieRun(meta);
    }
    const { fromLabel } = this.resolveSenderLabel(from);
    const prefixed = `[message from ${fromLabel}] ${text}`;
    const entry: NormalizedEntry = {
      ts: new Date().toISOString(),
      kind: 'message',
      from: 'agent',
      fromLabel,
      text,
    };
    this.transcriptFor(runId).appendEntry(entry);
    this.ctx.events.broadcast({ type: 'run.log', runId, entry });
    executorRun.send(prefixed);
    return meta;
  }

  // The agent->human channel (spec's `message_user`): records a
  // `from: 'agent'` message entry on the CALLING run's own transcript —
  // labeled with that same run's task title + id — so an agent can flag a
  // question or update to the human without waiting for its own assistant
  // output to be read. Unlike `inject`, there is no separate recipient run
  // to deliver text into; this only ever writes to `runId`'s own transcript
  // and broadcasts it, so a connected Session tab badges it immediately.
  // Same `running`-only liveness gate as `inject` — a run that isn't
  // actively running has no reason to be raising anything to the user right
  // now.
  messageUser(runId: string, text: string): RunMeta {
    const meta = this.requireRun(runId);
    if (meta.state !== 'running') {
      throw new OrchestratorConflictError(`run is not running: ${runId}`);
    }
    const entry: NormalizedEntry = {
      ts: new Date().toISOString(),
      kind: 'message',
      from: 'agent',
      fromLabel: `${meta.taskTitle} (${meta.id})`,
      toUser: true,
      text,
    };
    this.transcriptFor(runId).appendEntry(entry);
    this.ctx.events.broadcast({ type: 'run.log', runId, entry });
    return meta;
  }

  // Records a command the implementer actually ran, stamped with `at` here
  // so the caller can echo the record back — data in place of a prose report.
  recordEvidence(
    runId: string,
    evidence: Omit<CommandEvidence, 'at'>
  ): CommandEvidence {
    this.requireRun(runId);
    const full: CommandEvidence = { ...evidence, at: new Date().toISOString() };
    this.transcriptFor(runId).appendEvidence(full);
    this.ctx.events.broadcast({ type: 'run.changed' });
    return full;
  }

  // Records a mutation-test result via `record_mutation` — a guard reverted,
  // tests re-run. `testsFailed: 0` is what buildReviewPrompt flags.
  recordMutation(
    runId: string,
    mutation: Omit<MutationEvidence, 'at'>
  ): MutationEvidence {
    this.requireRun(runId);
    const full: MutationEvidence = {
      ...mutation,
      at: new Date().toISOString(),
    };
    this.transcriptFor(runId).appendMutation(full);
    this.ctx.events.broadcast({ type: 'run.changed' });
    return full;
  }

  // Records the human's reply to an `ask_user` question on the run's own
  // transcript. The agent gets it as its tool result, so nothing is injected.
  recordAnswer(runId: string, text: string): void {
    this.requireRun(runId);
    const entry: NormalizedEntry = {
      ts: new Date().toISOString(),
      kind: 'message',
      from: 'user',
      text,
    };
    this.transcriptFor(runId).appendEntry(entry);
    this.ctx.events.broadcast({ type: 'run.log', runId, entry });
  }

  /**
   * Asks a live run to stop gracefully — the Stop button's server side, and the
   * counterpart to `cancel()` below.
   *
   * `cancel()` kills the session where it stands and marks the run `cancelled`,
   * deliberately skipping handleFinish's auto-commit, so whatever the agent had
   * not committed is left loose in the worktree. This instead lets the agent
   * finish what it is doing and end its own turn, so the run reaches its normal
   * terminal state through handleFinish and its work is committed and
   * reviewable like any other finished run.
   *
   * That means this method changes no run state of its own. It records
   * `stopRequestedAt` (a marker, so surfaces can show "Stopping…" and then
   * "Stopped", and so a daemon restart mid-stop doesn't forget), tells the
   * executor, and arms the escalation timer that catches an agent which ignores
   * the request. Idempotent: pressing Stop twice re-signals the executor but
   * does not restart the clock or write a second marker.
   *
   * Deliberately synchronous with no `await` between reading the run's state
   * and appending its marker, for the same reason handleFinish is: an `await`
   * there would let a concurrent finish land in between, and the state line
   * written afterwards would carry the pre-finish state — resurrecting a
   * terminal run the next time its transcript is replayed.
   */
  requestStop(runId: string): RunMeta {
    const meta = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(`run already finished: ${runId}`);
    }
    const executorRun = this.registry.getExecutorRun(runId);
    // Same rule as approve()/sendMessage(): a non-terminal run with no
    // ExecutorRun is a zombie left by a dead daemon. There is nothing to ask to
    // wind down, and pretending otherwise would leave it "Stopping…" forever.
    //
    // No separate "still provisioning" case, deliberately: every path that
    // creates a run goes registry.create -> transition('running') ->
    // startAndRegister in one synchronous block, and reconcileOnBoot force-fails
    // any non-terminal run it replays — so no caller can ever observe a
    // provisioning run whose executor simply has not been built yet.
    if (executorRun === undefined) this.healZombieRun(meta);

    if (meta.stopRequestedAt !== undefined) {
      executorRun.requestStop();
      return meta;
    }

    const now = new Date().toISOString();
    this.registry.updateMeta(runId, { stopRequestedAt: now, updatedAt: now });
    // Same shape as setRunArchived: a marker rides along on a state line
    // carrying the run's CURRENT state, since a stop request moves nothing.
    this.bestEffort(`recording stop request for run ${runId}`, () => {
      this.transcriptFor(runId).appendState(meta.state, now, {
        stopRequestedAt: now,
      });
    });
    // The Session log is where a reader asks "why did it wrap up here?" — a
    // run that just quietly stops mid-task otherwise looks like it gave up.
    const entry: NormalizedEntry = {
      ts: now,
      kind: 'system',
      text: 'Stop requested — the agent will finish its current operation and then stop.',
    };
    this.bestEffort(`logging stop request for run ${runId}`, () => {
      this.transcriptFor(runId).appendEntry(entry);
    });
    this.ctx.events.broadcast({ type: 'run.log', runId, entry });
    this.ctx.events.broadcast({ type: 'run.changed' });

    executorRun.requestStop();

    // Same rule as cancel(): a task file this can't write costs the Activity
    // line, never the stop itself.
    this.bestEffort(`recording stop request activity for run ${runId}`, () => {
      this.ctx.store.update(
        meta.taskId,
        {
          appendActivity: `${now} [run ${runId}] stop requested`,
          // Like cancel(), this has exactly one caller: a human pressing Stop.
          activityActor: this.ctx.actorContext?.humanRef,
        },
        now
      );
      this.ctx.cache.rebuild(this.ctx.store);
      this.ctx.events.broadcast({ type: 'task.changed' });
    });

    this.scheduleStopEscalation(runId);
    return this.registry.get(runId)!;
  }

  /**
   * Arms the backstop for a stop the agent never honors.
   *
   * A graceful stop asks; it cannot compel. An agent can sit in one very long
   * tool call, or read the wind-down instruction and keep calling tools anyway,
   * and a Stop button that leaves a run going indefinitely is not a stop. If
   * the run is still non-terminal when this fires, it falls back to `cancel()`
   * — the same hard interrupt the user could have pressed themselves.
   *
   * The timer is unref'd so it can never hold the daemon (or a test process)
   * open on its own, and is cleared by transition() the moment the run goes
   * terminal, which is the single choke point every terminal state passes
   * through.
   */
  private scheduleStopEscalation(runId: string): void {
    if (this.stopEscalationMs <= 0) return;
    const timer = setTimeout(() => {
      this.stopEscalations.delete(runId);
      const meta = this.registry.get(runId);
      if (meta === undefined || TERMINAL_RUN_STATES.has(meta.state)) return;
      this.noteTaskActivity(
        meta.taskId,
        `[run ${runId}] stop not honored within ${Math.round(this.stopEscalationMs / 1000)}s — escalating to cancel`
      );
      // Nothing is awaiting this: it runs from a timer callback, so an escaped
      // rejection would be an unhandled one.
      void this.cancel(runId).catch((err: unknown) => {
        console.error(
          `dispatchd: escalating stop to cancel failed for run ${runId}: ${(err as Error).message}`
        );
      });
    }, this.stopEscalationMs);
    timer.unref?.();
    this.stopEscalations.set(runId, timer);
  }

  // Cancels a pending escalation, because the run it was watching is done —
  // either it wound down on its own, or something else ended it first.
  private clearStopEscalation(runId: string): void {
    const timer = this.stopEscalations.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.stopEscalations.delete(runId);
  }

  // Interrupts a live run's executor and marks it cancelled. The worktree is
  // deliberately left in place — per the plan, only a review action
  // (merge/discard) removes a run's worktree.
  async cancel(runId: string): Promise<void> {
    const meta = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(`run already finished: ${runId}`);
    }
    // Before transition() below makes the run terminal, so it isn't a no-op.
    this.forceClaimsRefresh(runId);
    const executorRun = this.registry.getExecutorRun(runId);
    if (executorRun !== undefined) await executorRun.interrupt();
    this.transition(runId, 'cancelled');

    // M2: record the cancellation as a durable Activity line, same as every
    // other run-lifecycle event this task's file already tracks. The task's
    // own status is deliberately left as-is — cancelling a run says nothing
    // about whether the task itself should move (the user may immediately
    // re-dispatch it, or may have cancelled specifically to edit the task
    // first) — only a review action (merge/discard) or a fresh dispatch
    // changes task status.
    const now = new Date().toISOString();
    // Same rule as handleFinish: a task file this can't read or write costs
    // the Activity line, never the terminal hooks.
    this.bestEffort(`recording cancel for run ${runId}`, () => {
      this.ctx.store.update(
        meta.taskId,
        {
          appendActivity: `${now} [run ${runId}] cancelled`,
          // cancel() has exactly one caller: the human pressing Cancel via
          // the API — never something an agent or the daemon decides itself.
          activityActor: this.ctx.actorContext?.humanRef,
        },
        now
      );
      this.ctx.cache.rebuild(this.ctx.store);
      this.ctx.events.broadcast({ type: 'task.changed' });
    });
    this.fireTerminalHooks(runId);
  }

  // Surveys a run's worktree via git status/log. Degrades to an empty clean
  // survey, rather than throwing, when the worktree itself is gone.
  async surveyRun(runId: string): Promise<RunSurvey> {
    const meta = this.requireRun(runId);
    const repo = new GitRepo(meta.worktreePath);
    const [statusResult, logResult] = await Promise.all([
      repo.status(),
      repo.log({ limit: 1 }),
    ]);
    const staged = statusResult.ok
      ? statusResult.staged.map((f) => f.path)
      : [];
    // No dedicated conflicted field on RunSurvey — folded into unstaged,
    // marked, so a resumed agent still sees it instead of an unexplained tree.
    const unstaged = statusResult.ok
      ? [
          ...statusResult.unstaged.map((f) => f.path),
          ...statusResult.conflicted.map((path) => `${path} (conflicted)`),
        ]
      : [];
    const untracked = statusResult.ok ? [...statusResult.untracked] : [];
    const firstCommit = logResult.ok ? logResult.commits[0] : undefined;
    const lastCommit =
      firstCommit !== undefined
        ? { sha: firstCommit.sha, subject: firstCommit.subject }
        : null;
    return {
      runId,
      branch: meta.branch,
      staged,
      unstaged,
      untracked,
      lastCommit,
      cleanTree:
        staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    };
  }

  // Grows a run's claims to match its worktree's git status. Public so tests
  // can call it directly instead of waiting out the cooldown below.
  async refreshClaims(runId: string): Promise<void> {
    const meta = this.registry.get(runId);
    if (meta === undefined || TERMINAL_RUN_STATES.has(meta.state)) return;
    const status = await new GitRepo(meta.worktreePath).status();
    if (!status.ok) return;
    const touched = [
      ...status.staged.map((f) => f.path),
      ...status.unstaged.map((f) => f.path),
      ...status.untracked,
      ...status.conflicted,
    ];
    const before = meta.claims ?? [];
    const grown = new Set([...before, ...touched]);
    if (grown.size === before.length) return;
    const claims = [...grown].sort();
    this.registry.updateMeta(runId, { claims });
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // Cooldown-gated, fire-and-forget trigger for refreshClaims — called from
  // every executor entry so claims stay current without a dedicated poll timer.
  private scheduleClaimsRefresh(runId: string): void {
    const last = this.lastClaimsCheck.get(runId) ?? 0;
    if (Date.now() - last < this.claimsRefreshCooldownMs) return;
    this.forceClaimsRefresh(runId);
  }

  // Unconditional fire-and-forget refresh, bypassing the cooldown — used at
  // the transitions into an idle state, where a trailing edit must not wait.
  private forceClaimsRefresh(runId: string): void {
    this.lastClaimsCheck.set(runId, Date.now());
    void this.refreshClaims(runId).catch((err: unknown) => {
      console.error(
        `dispatchd: claims refresh failed for run ${runId}: ${(err as Error).message}`
      );
    });
  }

  // Fire-and-forget survey. No caller is left to receive a rejection, and this
  // decides `failed` vs `interrupted-dirty`, so a failure is logged, not lost.
  private scheduleSurvey(runId: string): void {
    const done = this.surveyAndUpgradeIfDirty(runId)
      .catch((err: unknown) => {
        console.error(
          `dispatchd: survey of run ${runId} failed: ${(err as Error).message}`
        );
      })
      .finally(() => {
        if (this.scheduledSurveys.get(runId) === done) {
          this.scheduledSurveys.delete(runId);
        }
      });
    this.scheduledSurveys.set(runId, done);
  }

  // Resolves once the scheduled survey for a run has settled, so a caller can
  // wait on the state it decides instead of guessing at how long it takes.
  surveySettled(runId: string): Promise<void> {
    return this.scheduledSurveys.get(runId) ?? Promise.resolve();
  }

  // Surveys a run already marked `failed` outside handleFinish (a boot
  // crash or a zombied executor) and upgrades it if the worktree is dirty.
  private async surveyAndUpgradeIfDirty(runId: string): Promise<void> {
    let survey: RunSurvey;
    try {
      survey = await this.surveyRun(runId);
    } catch (err) {
      console.error(
        `dispatchd: failed to survey run ${runId}: ${(err as Error).message}`
      );
      return;
    }
    if (survey.cleanTree) return;
    const meta = this.registry.get(runId);
    if (meta === undefined || meta.state !== 'failed') return;
    if (meta.reviewedAt !== undefined) return;
    // A resume took the worktree over while this survey was in flight, so what
    // it found is that run's tree, not a record of how this one was left.
    if (this.registry.list().some((r) => r.resumedFrom === runId)) return;
    const now = new Date().toISOString();
    this.registry.updateMeta(runId, {
      state: 'interrupted-dirty',
      updatedAt: now,
      survey,
    });
    // Same rule as transition(): the registry already carries the new state, so
    // a transcript that can't be written must not also cost the broadcasts.
    this.bestEffort(
      `appending interrupted-dirty state for run ${runId}`,
      () => {
        this.transcriptFor(runId).appendState('interrupted-dirty', now, {
          survey,
        });
      }
    );
    this.ctx.events.broadcast({ type: 'run.changed' });
    this.ctx.events.broadcast({ type: 'run.survey', runId, survey });
    this.noteTaskActivity(
      meta.taskId,
      `[run ${runId}] flagged interrupted-dirty: ${survey.staged.length + survey.unstaged.length + survey.untracked.length} uncommitted path(s) found`
    );
  }

  // The review surface's unified diff: everything committed on the run's
  // branch since it diverged from its base branch, plus per-file status.
  //
  // Every review path (local merge, discard, a merged PR) removes the run's
  // worktree, which used to make this permanently 404/409 the moment review
  // happened — the diff a reviewer just looked at would vanish right after
  // they acted on it. persistDiffSnapshot now writes that diff to disk right
  // before each removal, so once the live worktree is gone this falls back
  // to the snapshot instead of erroring. The live worktree is preferred
  // whenever it's still there (the common case pre-review) rather than ever
  // preferring a possibly-stale snapshot over the real thing.
  diff(runId: string): DiffResult {
    const meta = this.requireRun(runId);
    if (existsSync(meta.worktreePath)) {
      return this.worktrees.diff(meta.worktreePath, meta.baseBranch);
    }
    const snapshotPath = diffSnapshotPath(this.ctx.rootDir, runId);
    if (existsSync(snapshotPath)) {
      // A corrupt snapshot (persistDiffSnapshot's writeFileSync is not
      // atomic, so a crash mid-write can leave truncated/garbage JSON on
      // disk) must never escape as a raw SyntaxError — that would bypass
      // api.ts's typed-error mapping entirely and surface an opaque 500
      // with no CORS headers instead of the same 409 a missing snapshot
      // gets below. Treat a failed read/parse as "no usable snapshot" and
      // fall through to the OrchestratorConflictError.
      try {
        return JSON.parse(readFileSync(snapshotPath, 'utf8')) as DiffResult;
      } catch (err) {
        console.error(
          `dispatchd: failed to read diff snapshot for run ${runId}: ${(err as Error).message}`
        );
      }
    }
    throw new OrchestratorConflictError(
      `run has no worktree to diff: ${runId}`
    );
  }

  // Snapshots a run's diff to disk immediately before its worktree is
  // removed on a review path (local merge, discard, PR merge) — see diff()'s
  // comment for why this exists. `precomputed` lets mergeRun() reuse the
  // diff it already had to compute anyway (to decide whether there's
  // anything to squash) instead of shelling out to git twice. A snapshot
  // failure (a git error, a full disk) must never block the review action
  // itself — this only logs and returns, same convention as the other
  // best-effort hooks in this file.
  private persistDiffSnapshot(meta: RunMeta, precomputed?: DiffResult): void {
    try {
      const result =
        precomputed ?? this.worktrees.diff(meta.worktreePath, meta.baseBranch);
      mkdirSync(runsDir(this.ctx.rootDir), { recursive: true });
      writeFileSync(
        diffSnapshotPath(this.ctx.rootDir, meta.id),
        JSON.stringify(result)
      );
    } catch (err) {
      console.error(
        `dispatchd: failed to snapshot diff for run ${meta.id}: ${(err as Error).message}`
      );
    }
  }

  // Why `taskId` may not be merged, or null when nothing blocks it. Read from
  // the findings, not the fix loop: the ruling stands however that loop settled.
  blockedFindingReason(taskId: string): string | null {
    const blocked = this.findingStore.list({ taskId, verdict: 'blocked' });
    if (blocked.length === 0) return null;
    const first = blocked[0];
    const ruling = first.ruling ?? first.title;
    return `task is blocked by an adjudicated finding: ${taskId} (${first.id}: ${ruling})`;
  }

  // Terminal review action for a run: 'merge' squash-merges the branch into
  // the main checkout and closes the task; 'discard' just cleans up and
  // reopens the task. Both remove the run's worktree/branch — the worktree
  // stays around until exactly this call, per the plan.
  //
  // C2: review is only valid on a terminal run (nothing to review while a
  // run is still live), and only once per run — a run that already has a
  // `reviewedAt` has already been merged or discarded, and doing either
  // again would double-apply the task-status change or double-remove an
  // already-gone worktree/branch.
  // `actor` credits who reviewed this run: omitted (the API's Merge/Discard
  // buttons) defaults to the daemon's human; the merge queue's own automatic
  // merge passes 'none' explicitly — nobody clicked anything for that one.
  review(
    runId: string,
    action: string,
    opts: { actor?: string } = {}
  ): RunMeta {
    if (action !== 'merge' && action !== 'discard') {
      throw new OrchestratorClientError(`invalid review action: ${action}`);
    }
    const actor = opts.actor ?? this.ctx.actorContext?.humanRef;
    const meta = this.requireRun(runId);
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
    // Discarding blocked work is exactly what a human should still be able to
    // do; merging it is the thing the ruling exists to prevent.
    if (action === 'merge') {
      const blocked = this.blockedFindingReason(meta.taskId);
      if (blocked !== null) throw new OrchestratorConflictError(blocked);
    }
    this.requireNoOpenPr(meta);
    const now = new Date().toISOString();

    let mergeCommit: string | undefined;
    if (action === 'merge') {
      mergeCommit = this.mergeRun(meta, now, actor);
    } else {
      this.persistDiffSnapshot(meta);
      // Not while something else still needs the directory — a sibling run
      // sitting in the merge queue is about to rebase inside it.
      if (!this.worktreeIsNeeded(runId)) {
        this.worktrees.remove(meta.worktreePath, meta.branch, meta.id);
      }
      this.ctx.store.update(
        meta.taskId,
        {
          status: 'todo',
          appendActivity: `${now} run ${runId} discarded`,
          activityActor: actor,
        },
        now
      );
      this.flagStackedDependents(meta);
    }

    // Record the review marker as its own state-line append (transition()
    // to the *same* state — reviewing a run never changes its RunState,
    // only that it's now been reviewed).
    this.transition(runId, meta.state, {
      reviewedAt: now,
      reviewAction: action,
      mergeCommit,
    });
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    this.ctx.events.broadcast({ type: 'run.changed' });
    const reviewed = this.registry.get(runId)!;
    this.invokeHooksSafely(this.reviewedHooks, reviewed);
    return reviewed;
  }

  // Phase 5 P1: records a run's freshly-opened PR url. Called by
  // PrManager.openPr right after `gh pr create` succeeds — this run stays
  // un-reviewed (reviewedAt unset) until the PR poller sees it merged and
  // calls markRunMergedViaPr below. Not routed through transition() since
  // the run's RunState itself doesn't change here, only one more fact about
  // it becomes known — same rationale as review()'s reviewedAt-only update,
  // just without a state-transition side effect to piggyback on, so this
  // appends its own state line directly.
  setRunPrUrl(runId: string, url: string): RunMeta {
    const meta = this.requireRun(runId);
    const now = new Date().toISOString();
    this.registry.updateMeta(runId, { prUrl: url, updatedAt: now });
    this.transcriptFor(runId).appendState(meta.state, now, { prUrl: url });
    this.ctx.events.broadcast({ type: 'run.changed' });
    return this.registry.get(runId)!;
  }

  /**
   * Archives or unarchives a run.
   *
   * Nothing is deleted and nothing becomes unreachable — the transcript, the
   * diff snapshot and the review comments all stay exactly where they were.
   * This only sets a marker the Runs list uses to keep finished work out of
   * the way, because a project that has done a hundred runs should not have to
   * scroll past all hundred to find the one that is live.
   *
   * Unlike reviewedAt, this is reversible, so it is recorded with the same
   * same-state append but carries `null` to clear. Archiving is allowed in any
   * state: a run that failed on dispatch is exactly the kind of thing you want
   * out of the list, and refusing to hide it until it reaches some tidier
   * state would be the opposite of the point.
   */
  setRunArchived(runId: string, archived: boolean): RunMeta {
    const meta = this.requireRun(runId);
    const now = new Date().toISOString();
    const archivedAt = archived ? now : undefined;
    this.registry.updateMeta(runId, { archivedAt, updatedAt: now });
    this.transcriptFor(runId).appendState(meta.state, now, {
      archivedAt: archived ? now : null,
    });
    this.ctx.events.broadcast({ type: 'run.changed' });
    return this.registry.get(runId)!;
  }

  // Phase 5 P1: the PR poller's terminal action once GitHub reports a run's
  // PR as merged — mirrors review()'s 'discard' bookkeeping shape (worktree
  // cleanup + a task-file update) but marks the task `done` (the work really
  // did land, just via a remote PR merge rather than review()'s local
  // squash-merge) and records `reviewAction: 'pr'`. Deliberately does NOT
  // run mergeRun()'s local `git merge --squash` — that content already
  // landed on the remote base branch through the PR itself; redoing it
  // locally would either no-op or conflict with what's already there.
  markRunMergedViaPr(runId: string): RunMeta {
    const meta = this.requireRun(runId);
    if (meta.reviewedAt !== undefined) {
      throw new OrchestratorConflictError(
        `run has already been reviewed: ${runId}`
      );
    }
    const now = new Date().toISOString();
    // Deliberately `diffCommittedOnly`, not the live `diff()` the review
    // surface polls while a run is active: this run's content already landed
    // on the remote base branch through the PR itself, which only ever
    // contains what actually got committed to the branch — a stray
    // uncommitted or untracked file still sitting in this worktree (this
    // path skips mergeRun()'s own autoCommitIfDirty-adjacent handling) was
    // never part of that PR. Snapshotting the live diff here would bake that
    // never-merged content into the "merged" snapshot review() later serves
    // up as if it had actually landed — see mergeRun()'s own comment for the
    // same reasoning applied to its local-merge counterpart.
    const mergedDiff = this.worktrees.diffCommittedOnly(
      meta.worktreePath,
      meta.baseBranch
    );
    this.persistDiffSnapshot(meta, mergedDiff);
    this.worktrees.remove(meta.worktreePath, meta.branch, meta.id);
    this.ctx.store.update(
      meta.taskId,
      {
        status: 'done',
        appendActivity: `${now} run ${runId} merged via PR (${meta.prUrl ?? 'unknown url'})`,
        // The PR poller noticed GitHub reports it merged — whoever actually
        // merged it did so on GitHub, outside anything dispatch can see.
        activityActor: 'none',
      },
      now
    );
    this.transition(runId, meta.state, {
      reviewedAt: now,
      reviewAction: 'pr',
    });
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    const reviewedViaPr = this.registry.get(runId)!;
    this.invokeHooksSafely(this.reviewedHooks, reviewedViaPr);
    return reviewedViaPr;
  }

  // C1: squash-merges `meta.branch` into the main checkout and folds this
  // run's own task-file bookkeeping into that same commit. Ordering is load-
  // bearing here: the squash-merge runs *before* any task-file edit, so a
  // failed merge (a real content conflict, or main having moved in a way
  // that no longer fast-forwards/merges cleanly) never leaves the task
  // marked done for work that was never actually merged in — and the task
  // file itself never sits uncommitted-and-staged fighting the merge for the
  // same path (see the back-to-back-merge regression this ordering fixes:
  // the previous order staged the *edited* task file before merging, so git
  // refused the second run's merge with "local changes ... would be
  // overwritten").
  private mergeRun(
    meta: RunMeta,
    now: string,
    actor: string | undefined
  ): string | undefined {
    // All three gates below describe the MAIN CHECKOUT, not this run, and all
    // three clear the moment the user commits/stashes/checks out — so they
    // throw MergeEnvironmentError rather than a plain conflict, which is what
    // lets the merge queue hold an entry in line and retry instead of failing
    // it out to history (see MergeQueue's 'blocked-environment' state).
    //
    // The dirty gate deliberately ignores `.dispatch/` — Activity/status
    // edits dispatchd itself made while running this task (dispatch,
    // finish, prior request-changes) are expected bookkeeping, not
    // unrelated user work; a genuinely dirty checkout (the user's own
    // pending changes elsewhere) still refuses the merge.
    const dirtyPaths = this.mainDirtyPathsOutsideDispatch();
    if (dirtyPaths.length > 0) {
      throw new MergeEnvironmentError(
        Orchestrator.describeDirtyPaths(dirtyPaths)
      );
    }
    // Staged changes anywhere — including `.dispatch/` paths the gate above
    // deliberately admits — would be swept into the squash commit, because
    // `git commit` commits the whole index. Refuse instead of committing
    // work the user staged for something else.
    if (this.worktrees.hasStagedChanges()) {
      throw new MergeEnvironmentError(
        'main checkout index has staged changes — commit or unstage them first'
      );
    }
    // C4: refuse outright if the main checkout isn't actually sitting on
    // the branch this run was based on — merging here would land the run's
    // changes on whatever branch the user happens to have checked out,
    // silently, which is worse than just refusing.
    const currentBranch = this.currentMainBranch();
    if (currentBranch !== meta.baseBranch) {
      throw new MergeEnvironmentError(
        `merge target is ${currentBranch}, expected ${meta.baseBranch}`
      );
    }

    const message = `dispatch: ${meta.taskTitle} (run ${meta.id})`;
    // A run whose branch never diverged in content from its base (a chatty
    // run that made no file changes) has nothing to squash — skip
    // mergeSquash entirely rather than let its trailing `git commit` fail
    // with "nothing to commit" on an otherwise perfectly valid merge.
    //
    // Deliberately `diffCommittedOnly`, not the live `diff()` the review
    // surface polls: `git merge --squash branch` below only ever pulls in
    // commits reachable from `meta.branch`, so `hasChanges` must match that
    // exact same universe. Every terminal-finish path runs
    // `autoCommitIfDirty` before a run ever becomes reviewable (see
    // handleFinish), so in the normal finished/failed case the worktree is
    // already fully committed and the two diffs agree — but `cancel()`
    // deliberately does *not* run that auto-commit (a cancelled run's
    // worktree is left as-is), so a cancelled run can still be sitting on
    // stray uncommitted or untracked files when it reaches review(). Using
    // the live diff here would count those as `hasChanges`, drive
    // `mergeSquash` on a branch with no actual new commits (which fails
    // trying to commit nothing), and would persist a "merged" snapshot that
    // includes content the squash never actually merged into main. Using
    // `diffCommittedOnly` keeps this decision anchored to what the squash
    // itself will really do, regardless of what the live worktree happens to
    // look like.
    const preMergeDiff = this.worktrees.diffCommittedOnly(
      meta.worktreePath,
      meta.baseBranch
    );
    const hasChanges = preMergeDiff.files.length > 0;
    if (hasChanges) {
      try {
        this.worktrees.mergeSquash(meta.branch, message);
      } catch (err) {
        // A failed `git merge --squash` (a real conflict) leaves the main
        // checkout mid-merge — conflict markers in the working tree, a
        // partially-populated index. `git reset --merge` restores it to a
        // clean HEAD so a retry (after the user resolves things by hand, or
        // just discards the run) starts from a sane state instead of a
        // permanently wedged checkout.
        Bun.spawnSync(['git', 'reset', '--merge'], { cwd: this.ctx.rootDir });
        // git's own stderr (already folded into err.message by
        // WorktreeManager.mergeSquash) is the useful part here — a content
        // conflict is a 409 the user can act on, never an opaque 500.
        throw new OrchestratorConflictError((err as Error).message);
      }
    }

    // Only now — once the squash-merge commit genuinely exists (or there was
    // nothing to squash in the first place) — record the task as done.
    // Stage *only* this run's own task file (not the whole `.dispatch/`
    // directory, Important #5) so an unrelated pending edit elsewhere under
    // `.dispatch/` (the user's own `config.yml` change, which the dirty gate
    // above deliberately let through) never rides along into this commit.
    this.ctx.store.update(
      meta.taskId,
      {
        status: 'done',
        appendActivity: `${now} run ${meta.id} merged into ${meta.baseBranch}`,
        activityActor: actor,
      },
      now
    );
    this.stageTaskFile(meta.taskId);
    // Fold the task-file bookkeeping into the squash commit when one exists;
    // otherwise this task-only commit *is* the merge's entire effect.
    const commitArgs = hasChanges
      ? ['commit', '--amend', '--no-edit']
      : ['commit', '-m', message];
    Bun.spawnSync(['git', ...commitArgs], { cwd: this.ctx.rootDir });

    this.persistDiffSnapshot(meta, preMergeDiff);
    this.worktrees.remove(meta.worktreePath, meta.branch, meta.id);
    // Only a real squash-merge produced a new commit worth pointing at — the
    // no-changes path's task-only commit is bookkeeping, not a merge.
    return hasChanges ? this.worktrees.resolveCommit('HEAD') : undefined;
  }

  /**
   * Every `dispatch/*` branch ref that exists in git right now, joined with
   * whatever the run registry knows about it — the data behind the Branches
   * surface.
   *
   * Enumeration starts from GIT, not from the registry, and that direction is
   * the whole point: `pruneOrphans` scans the worktrees *directory*, so a ref
   * whose directory is already gone is invisible to every other code path and
   * leaks forever. Starting from `for-each-ref` is what surfaces it.
   *
   * The join is deliberately one-directional. Git is authoritative for "does
   * this exist"; the registry is authoritative for "what does it mean".
   * Neither side is mutated to agree with the other — disagreement comes out
   * as a `status` value (see BranchEntryStatus) instead of being silently
   * reconciled, so a failed cleanup becomes visible rather than invisible.
   *
   * Registry entries whose ref is already gone are intentionally NOT listed:
   * there is nothing left to clean up, and including them would turn every
   * run in project history into permanent noise on this surface.
   */
  listBranches(): BranchEntry[] {
    const refs = this.worktrees.listBranches(DISPATCH_BRANCH_PREFIX);
    const pathByBranch = new Map<string, string>();
    for (const wt of this.worktrees.listWorktrees()) {
      if (wt.branch !== undefined) pathByBranch.set(wt.branch, wt.path);
    }
    const runByBranch = this.newestRunByBranch();
    // Orphan refs have no recorded base branch of their own, so they're
    // measured against the project's default base. Resolved once per call
    // (it shells out to git) and tolerant of failure: a repo with no remote
    // and an unborn HEAD would otherwise take the whole listing down.
    let fallbackBase: string;
    try {
      fallbackBase = this.worktrees.defaultBaseBranch();
    } catch {
      fallbackBase = 'HEAD';
    }

    const entries = refs.map((ref) => {
      const meta = runByBranch.get(ref.branch);
      const wtPath = pathByBranch.get(ref.branch) ?? meta?.worktreePath;
      const base = meta?.baseBranch ?? fallbackBase;
      const worktreeExists = wtPath !== undefined && existsSync(wtPath);
      return {
        branch: ref.branch,
        worktreePath: wtPath,
        worktreeExists,
        // Only measured when the directory is actually there — a reclaimed
        // worktree has nothing to weigh, and reporting 0 for it would read as
        // "measured and empty" rather than "gone".
        diskBytes: worktreeExists ? dirSizeBytes(wtPath).bytes : undefined,
        dirty: wtPath !== undefined && this.worktrees.isWorktreeDirty(wtPath),
        lastCommitAt: ref.lastCommitAt === '' ? undefined : ref.lastCommitAt,
        ahead: this.worktrees.aheadCount(ref.branch, base),
        mergedIntoBase: this.worktrees.isMergedInto(ref.branch, base),
        runId: meta?.id,
        taskId: meta?.taskId,
        taskTitle: meta?.taskTitle,
        runState: meta?.state,
        baseBranch: meta?.baseBranch,
        reviewedAt: meta?.reviewedAt,
        stackParents: meta?.stackParents,
        prUrl: meta?.prUrl,
        pushedToOrigin:
          meta?.mergeCommit !== undefined &&
          this.worktrees.isOnOriginBase(meta.mergeCommit, base),
        status: branchEntryStatus(meta),
      } satisfies BranchEntry;
    });

    // Most-urgent-first within a stable order so the UI's grouping never has
    // to re-sort, and so two consecutive polls can't shuffle rows around.
    return entries.sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? '');
    });
  }

  // Indexes runs by branch name, keeping the NEWEST run per branch.
  // `sendMessage(..., { resume: true })` deliberately reuses one task's
  // existing branch and worktree across a chain of request-changes follow-up
  // runs, so several RunMeta can legitimately claim the same branch — the
  // latest one is the one whose review state actually governs whether that
  // branch is still cleanable.
  private newestRunByBranch(): Map<string, RunMeta> {
    const byBranch = new Map<string, RunMeta>();
    for (const meta of this.registry.list()) {
      const existing = byBranch.get(meta.branch);
      if (existing === undefined || meta.createdAt >= existing.createdAt) {
        byBranch.set(meta.branch, meta);
      }
    }
    return byBranch;
  }

  /**
   * Reclaims a branch's worktree DIRECTORY while leaving its branch ref alone
   * — the "free disk" action. Reversible by design: `git worktree add` can
   * recreate the working copy from the surviving ref, whereas deleting the ref
   * on an unmerged branch destroys those commits outright.
   *
   * The run's own bookkeeping is deliberately untouched, so a `reviewable` run
   * stays reviewable afterwards. `meta.worktreePath` is left pointing at a
   * directory that no longer exists, which is safe because `diff()` already
   * tests `existsSync` on it and falls back to the snapshot persisted just
   * below — the same mechanism every review path already relies on.
   */
  freeWorktreeDisk(branch: string): BranchEntry {
    const entry = this.requireCleanableBranch(branch);
    const meta =
      entry.runId !== undefined ? this.registry.get(entry.runId) : undefined;
    if (meta !== undefined) this.persistDiffSnapshot(meta);
    if (entry.worktreePath !== undefined) {
      this.worktrees.removeWorktreeOnly(entry.worktreePath);
    }
    this.ctx.events.broadcast({ type: 'run.changed' });
    return this.requireBranchEntry(branch);
  }

  /**
   * Deletes a branch ref and its worktree outright — the cleanup path for an
   * `orphan` (no run claims it) or a `leftover` (a prior remove() failed
   * silently). Snapshots the diff first when a run is known, so a still-listed
   * run's review surface keeps working afterwards.
   *
   * Refuses an unmerged branch unless `force` is set: `mergedIntoBase` proves
   * the commits already landed on the base branch, and without that proof this
   * is the one action here that destroys work with no way back.
   */
  deleteBranch(branch: string, opts: { force?: boolean } = {}): void {
    const entry = this.requireCleanableBranch(branch);
    if (!entry.mergedIntoBase && opts.force !== true) {
      throw new OrchestratorConflictError(
        `branch is not merged into ${entry.baseBranch ?? 'its base'} and has ${entry.ahead} unmerged commit(s): ${branch} — retry with force to delete anyway`
      );
    }
    const meta =
      entry.runId !== undefined ? this.registry.get(entry.runId) : undefined;
    if (meta !== undefined) this.persistDiffSnapshot(meta);
    if (entry.worktreePath !== undefined) {
      this.worktrees.remove(entry.worktreePath, branch);
    } else {
      this.worktrees.removeBranchRef(branch);
    }
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  private requireBranchEntry(branch: string): BranchEntry {
    const entry = this.listBranches().find((e) => e.branch === branch);
    if (entry === undefined) {
      throw new OrchestratorNotFoundError(`branch not found: ${branch}`);
    }
    return entry;
  }

  // The shared guard for both destructive branch actions. Refuses anything
  // that would pull a worktree or ref out from under something still using it,
  // naming the specific reason so the UI can show it verbatim.
  private requireCleanableBranch(branch: string): BranchEntry {
    const all = this.listBranches();
    const entry = all.find((e) => e.branch === branch);
    if (entry === undefined) {
      throw new OrchestratorNotFoundError(`branch not found: ${branch}`);
    }
    // A live agent is actively writing into this worktree.
    if (entry.status === 'active') {
      throw new OrchestratorConflictError(
        `branch has a live run: ${branch} (run ${entry.runId ?? 'unknown'}, state ${entry.runState ?? 'unknown'})`
      );
    }
    // Same rule review() enforces: an open PR points at exactly this branch
    // and worktree, so tearing them down would break the remote review.
    const meta =
      entry.runId !== undefined ? this.registry.get(entry.runId) : undefined;
    if (meta !== undefined) this.requireNoOpenPr(meta);
    // `git branch -D` would refuse the checked-out branch anyway; failing
    // here names the reason instead of surfacing git's error text.
    if (branch === this.currentMainBranch()) {
      throw new OrchestratorConflictError(
        `branch is checked out in the main repo: ${branch}`
      );
    }
    this.requireNoStackedDependent(branch, all);
    return entry;
  }

  /**
   * Refuses when another dispatch branch was cut from `branch` — the stacked
   * case. A dependent's diff and eventual merge are both anchored on its merge
   * base with this ref, so deleting it doesn't fail loudly, it silently
   * repoints that dependent at whatever unrelated commit git falls back to.
   *
   * Scoped to the raw branch actions (delete, free-disk) on purpose, and NOT to
   * `review(id, 'discard')`. The difference is what each layer can do about it:
   * these two are pure git operations with no run bookkeeping to hang a marker
   * on, so refusing is the only way they can avoid corrupting a dependent.
   * `review()` does have that bookkeeping, so discarding a blocker instead
   * flags every dependent with `baseDiscarded` and lets the merge queue refuse
   * it later with a specific reason — which keeps the human free to reject work
   * without first dismantling everything stacked above it.
   *
   * Deliberately has NO force escape hatch. Dependents form a DAG, so its
   * leaves are always cleanable right now — "clean up the dependent first"
   * always terminates, which means there is no legitimate case that needs to
   * override this, and every case that would override it corrupts a diff.
   *
   * `entries` is passed in by callers that already computed listBranches() so
   * the guard and the rows the user is looking at can never disagree about what
   * depends on what.
   */
  private requireNoStackedDependent(
    branch: string,
    entries = this.listBranches()
  ): void {
    const dependent = entries.find(
      (e) => e.branch !== branch && e.baseBranch === branch
    );
    if (dependent !== undefined) {
      throw new OrchestratorConflictError(
        `branch is the base of ${dependent.branch} — clean that up first`
      );
    }
  }

  // ---------------------------------------------------------------------
  // Restack seam (MergeQueue.restackDependents). These five live here rather
  // than on the queue because the Orchestrator owns both the run registry and
  // the WorktreeManager — the queue must not reach into either directly.
  // ---------------------------------------------------------------------

  // Backs up a run's branch tip before something rewrites it, returning the
  // saved sha (or null when there's nothing to back up). This is the undo
  // path for a restack, never its rebase boundary — see
  // MergeQueue.restackDependents.
  backupRunBranch(runId: string): string | null {
    const meta = this.registry.get(runId);
    if (meta === undefined) return null;
    return this.worktrees.writeBackupRef(meta.branch, runId);
  }

  // Replays a run's OWN commits (everything after `oldTip`, the commit it was
  // branched from) onto `newBase`, leaving behind the blocker commits the new
  // base already contains in squashed form.
  rebaseRunOnto(runId: string, newBase: string, oldTip: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    this.worktrees.rebaseOnto(meta.worktreePath, newBase, oldTip, meta.branch);
  }

  /**
   * Whether any run is currently ALIVE in the worktree `runId` occupies —
   * including `runId` itself.
   *
   * This, not "is this run terminal?", is the invariant every rewrite of a
   * worktree or its branch has to hold against. The two coincide for
   * `dispatch()`, which gives every run its own branch and worktree, and come
   * apart for `requestChanges()`, which starts a NEW run in the SAME worktree
   * on the SAME branch: the old run stays terminal forever while its
   * replacement's agent is actively writing there. Asking about the run
   * therefore answers the wrong question — the thing being protected is the
   * directory, and the directory can have more than one run's name on it.
   */
  private readonly worktreeClaims: ((worktreePath: string) => boolean)[] = [];

  worktreeIsBusy(runId: string): boolean {
    const meta = this.registry.get(runId);
    if (meta === undefined) return false;
    return this.registry
      .list()
      .some(
        (r) =>
          r.worktreePath === meta.worktreePath &&
          !TERMINAL_RUN_STATES.has(r.state)
      );
  }

  /**
   * Whether anything still NEEDS this worktree to exist.
   *
   * Deliberately distinct from `worktreeIsBusy`, which asks whether an agent is
   * writing here right now — the question a restack has to ask before it
   * rewrites a working copy. This is the weaker, wider question a *deletion*
   * has to ask, and the two came apart in a real failure: a run waiting in the
   * merge queue is `finished`, so nothing was live, so reviewing a sibling
   * removed the directory the queue was about to rebase in. The rebase then
   * failed with ENOENT from posix_spawn, which reads as a missing git binary
   * and is nothing of the sort.
   *
   * Conflating the two is not harmless in the other direction either: making
   * queued entries look "busy" stops their dependents from ever being
   * restacked, because restacking asks the same method.
   */
  worktreeIsNeeded(runId: string): boolean {
    const meta = this.registry.get(runId);
    if (meta === undefined) return false;
    if (this.worktreeClaims.some((claims) => claims(meta.worktreePath))) {
      return true;
    }
    return this.worktreeIsBusy(runId);
  }

  /**
   * Lets another subsystem declare a worktree in use for reasons the run
   * registry cannot see.
   *
   * A callback rather than a direct MergeQueue reference: the orchestrator is
   * constructed first and the queue is built on top of it, so pointing back at
   * the queue would be a cycle. This keeps the dependency one-way — the queue
   * knows about the orchestrator, and the orchestrator only knows that
   * *something* may hold a claim.
   */
  onWorktreeClaim(claims: (worktreePath: string) => boolean): void {
    this.worktreeClaims.push(claims);
  }

  // Reattaches a run's worktree to its branch after a restack moved that
  // branch from the main checkout. Throws rather than silently skipping while
  // anything is live in that worktree: a working copy an agent is using is
  // never rewritten underneath it, and every caller either treats the failure
  // as a reason to flag the run (MergeQueue.restackRun) or must not proceed to
  // verify/merge a tree that no longer matches its branch (MergeQueue.rebase).
  resyncRunWorktree(runId: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    if (this.worktreeIsBusy(runId)) {
      throw new OrchestratorConflictError(
        `refusing to resync ${meta.worktreePath}: another run is live in it`
      );
    }
    this.worktrees.resyncToBranch(meta.worktreePath, meta.branch);
  }

  // Whether a run's worktree still holds uncommitted content. Checked before
  // a restack: `resyncToBranch`'s hard reset would discard it, and every
  // normal finish path auto-commits, so this is only ever true for a
  // cancelled run whose worktree was deliberately left as-is.
  runWorktreeIsDirty(runId: string): boolean {
    const meta = this.registry.get(runId);
    if (meta === undefined) return false;
    return this.worktrees.isDirty(meta.worktreePath);
  }

  /**
   * Moves a run off a base branch that has now been merged away (and deleted
   * with its worktree), and drops that branch from its recorded stack parents.
   * Without this the next merge attempt is refused outright by mergeRun's
   * "merge target is X, expected Y" guard.
   *
   * Applied to EVERY unreviewed run sharing this branch, not just `runId`. A
   * restack rewrites a BRANCH, and `requestChanges()` puts several runs on one
   * branch; repointing only one of them would leave its siblings claiming a
   * base that no longer exists and still naming the merged blocker as a stack
   * parent — so the next sweep would rebase the same branch a second time,
   * replaying commits that are already on the new base.
   *
   * The new base is appended to each run's transcript as a state line — the
   * registry is in-memory only, so without that a restart would replay the
   * run's meta straight back onto the merged-away branch, with nothing left
   * to notice or re-run the restack (see TranscriptStateLine.baseBranch).
   */
  repointRunBase(runId: string, newBase: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    const mergedAway = meta.baseBranch;
    const now = new Date().toISOString();
    for (const sibling of this.registry.list()) {
      if (sibling.branch !== meta.branch) continue;
      if (sibling.reviewedAt !== undefined) continue;
      const remaining = (sibling.stackParents ?? []).filter(
        (branch) => branch !== mergedAway
      );
      this.registry.updateMeta(sibling.id, {
        baseBranch: newBase,
        stackParents: remaining.length > 0 ? remaining : undefined,
        updatedAt: now,
      });
      this.transcriptFor(sibling.id).appendState(sibling.state, now, {
        baseBranch: newBase,
        stackParents: remaining,
      });
    }
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // Called from review()'s discard branch: everything stacked on the
  // just-discarded run's branch was written against a base a human just
  // rejected. Flag every un-reviewed dependent for human attention and
  // change NOTHING else — the dependent's own worktree, branch, and any
  // in-flight work are left completely intact. Auto-rebasing it onto the
  // default base would silently strip the code it was written against, and
  // cascading the discard would throw away work a human never rejected;
  // only a human gets to make that call. Reuses flagRunRestackFailure's
  // `baseDiscarded` flag and its persistence/Activity shape rather than
  // inventing a second one for the same "needs a human" meaning — the two
  // uses are compatible: MergeQueue.isRestackCandidate already treats
  // `baseDiscarded` as "do not touch this automatically" regardless of which
  // path set it.
  private flagStackedDependents(discarded: RunMeta): void {
    for (const dependent of this.registry.list()) {
      // Already merged or discarded runs are done; they must never be
      // touched again, and a run without this branch in its stack simply
      // wasn't built on top of it.
      if (dependent.reviewedAt !== undefined) continue;
      if (dependent.stackParents?.includes(discarded.branch) !== true) {
        continue;
      }
      // A live dependent is left completely alone, the same rule the restack
      // path follows: flagging it would stamp an error chip and a mid-run
      // state line onto a run whose agent is working perfectly happily. It is
      // picked up instead the moment its worktree goes quiet — see
      // MergeQueue.restackStaleRun, which flags a run whose stack parent was
      // discarded rather than merged.
      if (this.worktreeIsBusy(dependent.id)) continue;
      const reason = `the run this one was stacked on (${discarded.id}) was discarded — rebase onto a valid base before merging`;
      this.flagRunRestackFailure(dependent.id, reason);
      this.appendRunTaskActivity(dependent.id, `run ${dependent.id} ${reason}`);
    }
  }

  // Records that a dependent could not be restacked after its base merged.
  // Reuses the `baseDiscarded` flag's "a human needs to look at this" meaning
  // rather than inventing a second flag for the same UI treatment: either way
  // the base this work was written against is no longer something the queue
  // can merge it onto by itself.
  //
  // Persisted to the transcript for the same reason repointRunBase is: this
  // flag is the ONLY record that a run needs human attention, and the restack
  // is never retried on its own, so losing it across a restart would leave a
  // broken run looking perfectly healthy.
  //
  // `reason` never overwrites an `error` the run already had. A `failed` run's
  // own failure message is the more important one — it says why the work is
  // broken, where this only says why the base could not be moved — and since
  // the write is now persisted, clobbering it would destroy it for good.
  // `baseDiscardedReason` is set unconditionally instead, so the flag always
  // travels with the reason it was actually raised for and no surface has to
  // fall back to fixed copy that is wrong for two of its three meanings.
  flagRunRestackFailure(runId: string, reason: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    const now = new Date().toISOString();
    const patch =
      meta.error === undefined
        ? { baseDiscarded: true, baseDiscardedReason: reason, error: reason }
        : { baseDiscarded: true, baseDiscardedReason: reason };
    this.registry.updateMeta(runId, { ...patch, updatedAt: now });
    this.transcriptFor(runId).appendState(meta.state, now, patch);
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // One Activity line on a run's own task, used by the merge queue to leave a
  // durable record of a restack (or a refusal to restack) on the run the user
  // is actually looking at, not just on the blocker that triggered it.
  appendRunTaskActivity(runId: string, text: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    this.appendTaskActivity(meta.taskId, text);
  }

  // Stamps `archivedAt` on every `done` task whose newest merged run has
  // actually landed on origin's copy of its base — the signal that it's safe
  // to let the task drop out of the visible Done column for good. Called from
  // reconcileOnBoot() and from MergeQueue.refreshRemote()'s 60s tick, both
  // after origin's refs are as current as this process can make them.
  // Idempotent by construction: query()'s default filter already excludes
  // archived tasks, so a repeat call only ever touches tasks that just became
  // eligible — never un-archives one that already was.
  reconcileArchives(): number {
    if (!this.worktrees.hasOriginRemote()) return 0;
    const doneTasks = this.ctx.cache.query({ status: 'done' });
    if (doneTasks.length === 0) return 0;
    // Newest merged run per task, scanned once against registry.list()'s own
    // most-recent-first order — mirrors newestRunByBranch()'s same shape. Safe
    // to key purely on `reviewAction === 'merge'` here: a discarded run's task
    // is flipped back to 'todo' by review() (never left at 'done'), so it
    // never reaches `doneTasks` above for a discard to be mistaken for this.
    const newestMergedByTask = new Map<string, RunMeta>();
    for (const run of this.registry.list()) {
      if (run.reviewAction !== 'merge' || run.mergeCommit === undefined) {
        continue;
      }
      if (!newestMergedByTask.has(run.taskId)) {
        newestMergedByTask.set(run.taskId, run);
      }
    }
    const now = new Date().toISOString();
    let count = 0;
    for (const task of doneTasks) {
      const run = newestMergedByTask.get(task.meta.id);
      if (run?.mergeCommit === undefined) continue;
      if (!this.worktrees.isOnOriginBase(run.mergeCommit, run.baseBranch)) {
        continue;
      }
      this.ctx.store.update(task.meta.id, { archivedAt: now }, now);
      count++;
    }
    if (count > 0) {
      this.ctx.cache.rebuild(this.ctx.store);
      this.ctx.events.broadcast({ type: 'task.changed' });
    }
    return count;
  }

  // Boot-time hygiene: any transcript whose last recorded state isn't
  // terminal represents a run dispatchd crashed mid-flight on — mark it
  // `failed` (both on disk and in the freshly-hydrated registry) so clients
  // never see a run stuck "running" forever with nothing actually running
  // it. Every transcript's worktreePath is then used as the keep-set for
  // pruning orphan worktree directories left by a crash before a transcript
  // header was even written. Every transcript's runId is also collected as
  // the keep-set for pruning orphaned `*.diff.json` snapshots (see below).
  reconcileOnBoot(): void {
    const dir = runsDir(this.ctx.rootDir);
    const keepPaths = new Set<string>();
    const keepRunIds = new Set<string>();
    // Runs THIS call just force-failed (not one replayed already-terminal)
    // — the actual crash victims, worth surveying below.
    const crashedRunIds: string[] = [];
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        // One transcript that fails to read at all (not just to parse —
        // e.g. a directory sitting where a file is expected, an unreadable
        // file left by a partial crash) must never take down boot
        // reconciliation for every other run; skip just this entry.
        try {
          const replay = replayTranscript(path);
          if (replay === null) continue;
          let meta = replay.meta;
          if (!TERMINAL_RUN_STATES.has(meta.state)) {
            const now = new Date().toISOString();
            new Transcript(path).appendState('failed', now);
            meta = { ...meta, state: 'failed', updatedAt: now };
            crashedRunIds.push(meta.id);
          }
          this.registry.create(meta);
          keepPaths.add(meta.worktreePath);
          keepRunIds.add(meta.id);
        } catch (err) {
          console.error(
            `dispatchd: skipping unreadable transcript ${path}: ${(err as Error).message}`
          );
        }
      }
      // Diff-snapshot GC: persistDiffSnapshot writes `<runId>.diff.json`
      // alongside each run's transcript, but nothing ever deletes it once the
      // run itself is gone (e.g. its transcript was manually removed, or a
      // future "delete run" action drops the .jsonl without also dropping
      // its snapshot). An orphaned snapshot is permanently unreachable —
      // diff() only ever looks one up by a runId the registry still knows
      // about — so it just wastes disk forever; sweep it here, once per
      // boot, using the same runId keep-set built above. `merge-queue.json`
      // lives in this same directory (see paths.ts's mergeQueuePath) but
      // never matches the `.diff.json` suffix below — skip it by name too,
      // as a defense-in-depth guard against ever deleting the live queue
      // state file here.
      for (const file of readdirSync(dir)) {
        if (file === 'merge-queue.json') continue;
        if (!file.endsWith('.diff.json')) continue;
        const runId = file.slice(0, -'.diff.json'.length);
        if (keepRunIds.has(runId)) continue;
        try {
          rmSync(join(dir, file));
        } catch (err) {
          console.error(
            `dispatchd: failed to remove orphaned diff snapshot ${file}: ${(err as Error).message}`
          );
        }
      }
    }
    this.worktrees.pruneOrphans(worktreesDir(this.ctx.rootDir), keepPaths);
    this.reconcileArchives();
    // Deferred, not awaited — reconcileOnBoot() stays synchronous, so each
    // crashed run's worktree is surveyed and upgraded in the background.
    for (const runId of crashedRunIds) {
      this.scheduleSurvey(runId);
    }
  }

  private requireRun(runId: string): RunMeta {
    const meta = this.registry.get(runId);
    if (meta === undefined)
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    return meta;
  }

  // Self-heals a "zombie" run: `meta.state` is still non-terminal (running /
  // awaiting-approval), but this daemon has no live ExecutorRun for it —
  // e.g. the process actually driving it crashed/restarted without ever
  // reaching handleFinish (an old daemon dying mid-run, or this daemon's own
  // dispatch()/requestChanges() start() call throwing after the run was
  // already registered as 'running'). reconcileOnBoot() already heals this
  // exact shape of zombie once, at boot, for every run whose transcript is
  // non-terminal; this covers the same run going zombie *after* boot, lazily,
  // the moment approve()/sendMessage()/inject() next tries to reach its
  // executor and finds nothing there.
  //
  // Reuses transition()'s state-line/registry-update/`run.changed` broadcast
  // for the state flip, and handleFinish()'s own "only move an in-progress
  // task to in-review" rule for the task-side bookkeeping — never reinventing
  // either. Always throws (return type `never`), so every call site's control
  // flow after it can assume a live `executorRun`.
  private healZombieRun(meta: RunMeta): never {
    const errorMessage =
      "this run's executor is no longer alive (the daemon restarted); the run has been marked failed";
    this.markRunFailed(
      meta,
      errorMessage,
      `[run ${meta.id}] marked failed: executor no longer alive (daemon restarted)`
    );
    throw new OrchestratorConflictError(errorMessage);
  }

  // Shared terminal-failure bookkeeping for a run that has to be force-failed
  // *outside* the normal handleFinish path — flips the run to 'failed' with
  // `error`, moves its task to 'in-review' only when it's still 'in-progress'
  // (handleFinish's own rule, never reinvented), records `activityNote` on the
  // task, and fires terminal hooks. The two force-fail paths funnel through
  // here so they stay identical: healZombieRun (the executor died out from
  // under an already-live run) and startAndRegister (the executor never
  // started at all). `activityNote` is prefixed with the timestamp here so
  // callers pass only the note text.
  private markRunFailed(
    meta: RunMeta,
    error: string,
    activityNote: string
  ): void {
    this.transition(meta.id, 'failed', { error });

    const task = this.ctx.store.get(meta.taskId);
    if (task !== null) {
      const now = new Date().toISOString();
      // Both callers (a dead executor found mid-run, a start() call that
      // never got off the ground) are the daemon detecting its own crash
      // recovery — no human or agent decided this.
      const patch: UpdatePatch = {
        appendActivity: `${now} ${activityNote}`,
        activityActor: 'none',
      };
      if (task.meta.status === 'in-progress') patch.status = 'in-review';
      this.ctx.store.update(meta.taskId, patch, now);
      this.ctx.cache.rebuild(this.ctx.store);
      this.ctx.events.broadcast({ type: 'task.changed' });
    }
    this.fireTerminalHooks(meta.id);
    // Deferred, same as reconcileOnBoot()'s crash sweep — a zombied run's
    // worktree may still hold whatever the agent left behind mid-task.
    this.scheduleSurvey(meta.id);
  }

  // Starts `executor` for a run that dispatch()/requestChanges() has already
  // registered and transitioned to 'running', then records its live
  // ExecutorRun so approve()/sendMessage()/inject() can reach it.
  //
  // If start() throws *synchronously* — most commonly the Claude Agent SDK
  // failing to locate its native CLI binary (a broken `--omit=optional`
  // install), but any spawn-time failure counts — the run would otherwise be
  // stranded 'running' forever with no ExecutorRun behind it: a zombie the
  // caller can neither message nor finish, whose only eventual resolution is a
  // later restart's healZombieRun stamping the misleading "the daemon
  // restarted" message on a daemon that never restarted. That error also
  // escapes all the way to Bun.serve's `error` handler as an opaque 500. This
  // converts both into one honest, immediate terminal failure carrying the
  // real error, so dispatch()/requestChanges() still return a run — just one
  // already 'failed' with a visible reason instead of a stuck 'running'.
  private startAndRegister(
    runId: string,
    opts: ExecutorStartOptions,
    executor: Executor
  ): void {
    let executorRun;
    try {
      executorRun = executor.start(opts, this.makeEvents(runId));
    } catch (err) {
      const raw = (err as Error).message;
      const meta = this.registry.get(runId);
      if (meta !== undefined) {
        this.markRunFailed(
          meta,
          `failed to start: ${raw.length > 0 ? raw : 'executor failed to start'}`,
          `[run ${runId}] failed to start: ${raw}`
        );
      }
      return;
    }
    this.registry.setExecutorRun(runId, executorRun);
  }

  // I4: once PrManager.openPr has pushed a run's branch and opened a PR
  // (recorded as meta.prUrl), every *local* review/resume action must
  // refuse rather than race the remote review — a local merge/discard
  // would tear down the very worktree/branch the open PR points at, and
  // resuming would keep pushing commits to a branch someone may already be
  // reviewing on GitHub. The poller (PrManager.pollOnce) already skips any
  // run that's been reviewed, so this is the complementary guard on the
  // still-open side.
  private requireNoOpenPr(meta: RunMeta): void {
    if (meta.prUrl !== undefined) {
      throw new OrchestratorConflictError(
        'run has an open PR — close or merge it on GitHub instead'
      );
    }
  }

  private transcriptFor(runId: string): Transcript {
    return new Transcript(transcriptPath(this.ctx.rootDir, runId));
  }

  // How many offending paths a dirty-checkout refusal names before it
  // summarises the rest — enough to identify the culprit in the common case
  // (one or two stray files) without turning an error message into a wall of
  // text when a user has a genuinely busy tree.
  private static readonly DIRTY_PATHS_SHOWN = 5;

  // The paths making the main checkout dirty outside `.dispatch/`, as
  // `git status --porcelain` reports them (so untracked files count too — a
  // stray download at the repo root blocks a merge exactly like a modified
  // source file). Empty means clean. See the long comment at the call site in
  // `mergeRun()` for why `.dispatch/` itself is excluded from this check.
  private mainDirtyPathsOutsideDispatch(): string[] {
    const result = Bun.spawnSync(
      ['git', 'status', '--porcelain', '--', '.', `:!${DISPATCH_DIR}`],
      { cwd: this.ctx.rootDir, stdout: 'pipe', stderr: 'pipe' }
    );
    return (
      result.stdout
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        // Porcelain lines are `XY <path>`; keep just the path so the message
        // reads as a file list rather than as git status output.
        .map((line) => line.replace(/^\S+\s+/, ''))
    );
  }

  // Renders the dirty paths into the refusal message. Naming them is the
  // whole point: "main checkout has uncommitted changes" on its own sent
  // users hunting through a repo for a blocker that was, in the incident that
  // motivated this, a single untracked zip at the root.
  private static describeDirtyPaths(paths: string[]): string {
    const shown = paths.slice(0, Orchestrator.DIRTY_PATHS_SHOWN);
    const rest = paths.length - shown.length;
    const suffix = rest > 0 ? ` (+${rest} more)` : '';
    return `main checkout has uncommitted changes: ${shown.join(', ')}${suffix} — commit, stash, or remove them, then retry`;
  }

  // C4: the branch actually checked out in the main checkout right now —
  // compared against a run's `baseBranch` before mergeRun() touches anything,
  // so a merge attempted while main is sitting on some other branch is
  // refused outright rather than landing on the wrong branch.
  private currentMainBranch(): string {
    const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: this.ctx.rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.stdout.toString('utf8').trim();
  }

  // Stages (but does not commit) *only* the one task file belonging to
  // `taskId` — never the whole `.dispatch/` directory (Important #5) — so
  // `git commit --amend` right after this in mergeRun() folds in exactly
  // this run's own bookkeeping and nothing else pending under `.dispatch/`.
  private stageTaskFile(taskId: string): void {
    const file = this.ctx.store.taskFilePath(taskId);
    if (file === null) return;
    Bun.spawnSync(['git', 'add', file], { cwd: this.ctx.rootDir });
  }

  // The onFinish safety net (see its call site's comment): commits whatever
  // is sitting uncommitted in a run's worktree under a clearly-marked `wip`
  // message. A no-op when the worktree is already clean — the common case,
  // since every executor is expected to commit its own work per the prompt's
  // explicit instruction.
  //
  // `--no-verify`: a run worktree has no `node_modules`, so a project's
  // pre-commit hook fails there for reasons unrelated to the content, and a
  // vetoed safety net strands the agent's work. The merge queue's verify steps
  // are still the real gate.
  //
  // Throws on failure so `finishRun` marks the run `failed` — work that could
  // not be committed is neither reviewable nor mergeable.
  private autoCommitIfDirty(worktreePath: string, runId: string): void {
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (status.stdout.toString('utf8').trim() === '') return;
    Bun.spawnSync(['git', 'add', '-A'], { cwd: worktreePath });
    const commit = Bun.spawnSync(
      [
        'git',
        'commit',
        '--no-verify',
        '-m',
        `wip(dispatch): uncommitted changes from run ${runId}`,
      ],
      { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
    );
    if (commit.exitCode !== 0) {
      // git splits its complaints across both streams; prefer stderr, fall
      // back to stdout so the message is never just an exit code.
      const stderr = commit.stderr.toString('utf8').trim();
      const detail =
        stderr.length > 0 ? stderr : commit.stdout.toString('utf8').trim();
      throw new Error(
        `could not commit the changes left in ${worktreePath}: ${detail}`
      );
    }
  }

  // Moves a run to `state`, updating the registry, appending a transcript
  // state line, and broadcasting `run.changed` — the one place all three of
  // those always happen together, so no caller can update one without the
  // others.
  private transition(
    runId: string,
    state: RunState,
    finish?: {
      costUsd?: number;
      turns?: number;
      sessionId?: string;
      error?: string;
      reviewedAt?: string;
      reviewAction?: 'merge' | 'discard' | 'pr';
      mergeCommit?: string;
    }
  ): void {
    const meta = this.registry.get(runId);
    // I6: once a run is terminal, nothing may transition it to a *different*
    // state — a stray/duplicate onFinish, an approval response racing a
    // cancel, etc. must never resurrect a run clients have already been told
    // is done. This is a no-op, not a throw: transition() is called from
    // fire-and-forget executor event callbacks that have nothing useful to
    // do with an exception. Reviewing a run (which calls transition() with
    // its own already-terminal `state`, just to attach reviewedAt/
    // reviewAction) is explicitly exempt — that's staying in place, not
    // leaving the terminal state.
    if (
      meta !== undefined &&
      TERMINAL_RUN_STATES.has(meta.state) &&
      meta.state !== state
    ) {
      console.error(
        `dispatchd: ignoring transition out of terminal state '${meta.state}' -> '${state}' for run ${runId}`
      );
      return;
    }
    const now = new Date().toISOString();
    // Whatever ended this run — winding down after a stop, its own finish, a
    // cancel, an escalation — there is nothing left for the stop backstop to
    // catch. This is the one point every terminal state passes through.
    if (TERMINAL_RUN_STATES.has(state)) this.clearStopEscalation(runId);
    this.registry.updateMeta(runId, {
      state,
      updatedAt: now,
      ...finish,
    });
    // The registry already carries the new state; a transcript that can't be
    // appended to must not also cost clients the broadcast that says so.
    this.bestEffort(`appending ${state} state line for run ${runId}`, () => {
      this.transcriptFor(runId).appendState(state, now, finish);
    });
    this.ctx.events.broadcast({ type: 'run.changed' });
    // Phase 5 P1: onRunTerminal is deliberately NOT fired from here. A run
    // "reaching" a terminal state is only fully visible to a subscriber once
    // handleFinish()/cancel() have also finished updating the run's *task*
    // (e.g. flipping it to `in-review`) — firing this mid-transition, before
    // that task update lands, is exactly the ordering bug that made the epic
    // engine see a stale `in-progress` task status on the very same tick a
    // run it was tracking finished. See the explicit fireTerminalHooks()
    // calls at the end of handleFinish()/cancel() instead.
  }

  // Fires every onRunTerminal subscriber for `runId`'s *current* meta — only
  // ever called once the run's terminal transition AND every bit of
  // bookkeeping that goes with it (task status, Activity) has already
  // landed, so a subscriber never observes a run whose task hasn't caught up
  // yet (see transition()'s comment for the bug this ordering avoids).
  private fireTerminalHooks(runId: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    // Nothing will ever refresh a terminal run's claims again.
    this.lastClaimsCheck.delete(runId);
    this.invokeHooksSafely(this.terminalHooks, meta);
  }

  // C2(b): runs every hook in `hooks` against `meta`, isolating each call —
  // a subscriber's own bug must never change the outcome of the operation
  // that fired it (a merge/discard/finish/cancel has already fully
  // committed its own effects by the time hooks run) and must never stop a
  // *different* subscriber from still getting its turn. A throwing hook is
  // logged server-side and recorded as an Activity line on the run's own
  // task, purely for visibility — never re-thrown.
  private invokeHooksSafely(
    hooks: ReadonlyArray<(meta: RunMeta) => void>,
    meta: RunMeta
  ): void {
    for (const hook of hooks) {
      try {
        hook(meta);
      } catch (err) {
        const message = (err as Error).message;
        console.error(
          `dispatchd: run lifecycle hook failed for run ${meta.id}: ${message}`
        );
        try {
          const now = new Date().toISOString();
          this.ctx.store.update(
            meta.taskId,
            {
              appendActivity: `${now} [hook error] ${message}`,
              // A subscriber (e.g. the epic engine) threw — the daemon's own
              // bookkeeping failed, not something a person or agent did.
              activityActor: 'none',
            },
            now
          );
          this.ctx.cache.rebuild(this.ctx.store);
          this.ctx.events.broadcast({ type: 'task.changed' });
        } catch {
          // Even the Activity append failing must not propagate — the
          // triggering operation's own result already stands regardless.
        }
      }
    }
  }

  // Bookkeeping between a run going terminal and its hooks firing: cleanup an
  // exception can skip is not cleanup, so a failed step is logged, not thrown.
  private bestEffort(label: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      console.error(`dispatchd: ${label} failed: ${(err as Error).message}`);
    }
  }

  // Builds the ExecutorEvents callbacks for one run, closing over its runId
  // so the Executor implementation never has to know it.
  private makeEvents(runId: string): ExecutorEvents {
    return {
      onEntry: (entry) => {
        this.transcriptFor(runId).appendEntry(entry);
        this.registry.updateMeta(runId, {
          updatedAt: new Date().toISOString(),
        });
        this.ctx.events.broadcast({ type: 'run.log', runId, entry });
        this.scheduleClaimsRefresh(runId);
      },
      onApprovalRequest: (request) => {
        this.registry.setPendingApproval(runId, request);
        this.transition(runId, 'awaiting-approval');
        this.ctx.events.broadcast({
          type: 'approval.requested',
          runId,
          requestId: request.requestId,
          toolName: request.toolName,
        });
        // Awaiting-approval can sit for arbitrarily long — capture whatever
        // this run just did rather than letting the cooldown delay it.
        this.forceClaimsRefresh(runId);
      },
      onSession: (sessionId) => this.recordSession(runId, sessionId),
      onFinish: (finish) => this.handleFinish(runId, finish),
    };
  }

  // Persists a run's resume handle as soon as the executor reports it, so a
  // run force-failed by reconcileOnBoot still satisfies sendMessage's
  // `resume: true` gate instead of coming back dead. Rides on a state line at
  // the run's CURRENT state, exactly like reviewedAt/mergeCommit already do,
  // so replayTranscript folds it in with no new line type. Skipped once
  // terminal: the finish line carries the session, and a late stray event
  // must not append a non-terminal state line after it.
  private recordSession(runId: string, sessionId: string): void {
    if (sessionId === '') return;
    const meta = this.registry.get(runId);
    if (meta === undefined || meta.sessionId === sessionId) return;
    if (TERMINAL_RUN_STATES.has(meta.state)) return;
    this.registry.updateMeta(runId, {
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    // Best-effort, like handleFinish's own transcript writes: an unwritable
    // transcript must not take down a live run mid-stream.
    try {
      this.transcriptFor(runId).appendState(
        meta.state,
        new Date().toISOString(),
        { sessionId }
      );
    } catch (err) {
      console.error(
        `dispatchd: recording session for run ${runId} failed: ${(err as Error).message}`
      );
    }
  }

  // Applies a run's terminal state: transitions it, computes the changed
  // file count for the Activity line (best-effort — a diff failure never
  // blocks recording the finish), and only flips the task to `in-review`
  // when it's still `in-progress` (it may have been moved elsewhere by a
  // human in the meantime).
  private handleFinish(
    runId: string,
    finish: {
      state: 'finished' | 'failed';
      costUsd?: number;
      turns?: number;
      sessionId?: string;
      error?: string;
    }
  ): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    // Fire-and-forget: races (doesn't provably beat) autoCommitIfDirty's
    // commit below. Lands after transition(→terminal) — for history only.
    this.forceClaimsRefresh(runId);
    // I6: this whole block runs from inside an executor's fire-and-forget
    // event plumbing (see makeEvents/onFinish) — there is no caller left to
    // catch an escaped throw, so one would either crash the process or (with
    // Bun's fire-and-forget async chains) silently vanish, leaving the run
    // stuck non-terminal forever: a zombie run that looks "running" with
    // nothing left driving it. Any failure in this run's own git bookkeeping
    // (most commonly: its worktree was deleted out from under it before it
    // finished) must downgrade the finish to `failed` instead.
    let effectiveFinish = finish;
    try {
      // Stop-hook safety net: an executor (any executor — this runs
      // regardless of which one finished) can stop with uncommitted changes
      // sitting in its worktree. The review surface's live diff (run below,
      // via WorktreeManager.diff()) already folds in uncommitted/untracked
      // content, but a squash-merge only ever pulls in what's actually
      // committed — so this auto-commit, run here before that diff, is what
      // makes those changes part of the run's real committed history and
      // therefore genuinely mergeable, instead of only ever showing up live
      // and then silently vanishing once the worktree is removed.
      this.autoCommitIfDirty(meta.worktreePath, runId);
    } catch (err) {
      // Keeps the executor's own report rather than replacing it: when the run
      // already failed, "connection dropped" is the diagnosis and the commit
      // problem is a consequence. The cost/turns/sessionId it measured are real
      // either way, and a survey of the still-dirty worktree follows below.
      const detail = `finish failed: ${(err as Error).message}`;
      effectiveFinish = {
        ...finish,
        state: 'failed',
        error:
          finish.error === undefined ? detail : `${finish.error}; ${detail}`,
      };
    }

    // Synchronous, no await before this — closes the window a concurrent
    // approve()/sendMessage()/inject() could otherwise race (see below).
    this.transition(runId, effectiveFinish.state, {
      costUsd: effectiveFinish.costUsd,
      turns: effectiveFinish.turns,
      sessionId: effectiveFinish.sessionId,
      error: effectiveFinish.error,
    });
    if (effectiveFinish.state === 'failed') {
      this.scheduleSurvey(runId);
    }

    let filesChanged = 0;
    if (effectiveFinish.state === 'finished') {
      try {
        filesChanged = this.worktrees.diff(meta.worktreePath, meta.baseBranch)
          .files.length;
      } catch {
        filesChanged = 0;
      }
    }
    const cost = (effectiveFinish.costUsd ?? 0).toFixed(2);
    const now = new Date().toISOString();
    // An unreadable or unwritable task file must not skip the hooks below,
    // which are what free the epic engine's next dispatch.
    this.bestEffort(`recording finish for run ${runId}`, () => {
      const task = this.ctx.store.get(meta.taskId);
      if (task === null) return;
      const patch: UpdatePatch = {
        appendActivity: `${now} [run ${runId}] finished: ${effectiveFinish.state} — ${filesChanged} files, $${cost}`,
        // The run's own executor reaching its own terminal state — credited
        // to the agent that ran it, not whoever happens to be operating the
        // daemon right now.
        activityActor: this.ctx.actorContext?.agentRef(meta.executor),
      };
      if (task.meta.status === 'in-progress') patch.status = 'in-review';
      this.ctx.store.update(meta.taskId, patch, now);
      this.ctx.cache.rebuild(this.ctx.store);
      this.ctx.events.broadcast({ type: 'task.changed' });
    });
    this.fireTerminalHooks(runId);
  }

  // Resolves which executor a request-changes redispatch should actually use
  // — normally just `executorName` itself, but a run's *original* executor
  // can go missing on this daemon (the bug this fixes): a run dispatched
  // with a dev-only executor ('fake') now being resumed under a release
  // daemon that only ever registers 'claude', or a run whose executor name
  // simply predates whatever this process happens to have registered.
  // Falls back to the default 'claude' executor if that's registered, else
  // the single other executor this daemon does have registered (so a
  // single-executor test harness/e2e daemon that never registers 'claude'
  // under its own name still resumes cleanly), else throws the same
  // `unknown executor` OrchestratorClientError dispatch() itself throws for
  // an unregistered name.
  private resolveExecutorForResume(executorName: string): {
    executor: Executor;
    name: string;
    substituted: boolean;
  } {
    const direct = this.executors.get(executorName);
    if (direct !== undefined) {
      return { executor: direct, name: executorName, substituted: false };
    }
    const fallbackDefault = this.executors.get(DEFAULT_EXECUTOR_NAME);
    if (fallbackDefault !== undefined) {
      return {
        executor: fallbackDefault,
        name: DEFAULT_EXECUTOR_NAME,
        substituted: true,
      };
    }
    if (this.executors.size === 1) {
      const [name, executor] = [...this.executors][0];
      return { executor, name, substituted: true };
    }
    throw new OrchestratorClientError(`unknown executor: ${executorName}`);
  }

  // The request-changes path: same task/branch/worktree as `oldMeta`, but a
  // fresh run id and transcript, resuming the executor's prior session.
  private requestChanges(
    oldMeta: RunMeta,
    text: string,
    actor: string | undefined
  ): RunMeta {
    const {
      executor,
      name: executorName,
      substituted,
    } = this.resolveExecutorForResume(oldMeta.executor);
    const now = new Date().toISOString();
    const runId = generateRunId(now);
    const meta: RunMeta = {
      id: runId,
      taskId: oldMeta.taskId,
      taskTitle: oldMeta.taskTitle,
      executor: executorName,
      state: 'provisioning',
      branch: oldMeta.branch,
      baseBranch: oldMeta.baseBranch,
      worktreePath: oldMeta.worktreePath,
      createdAt: now,
      updatedAt: now,
      sessionId: oldMeta.sessionId,
      // A follow-up must answer on the same model the conversation started
      // on; without this the resumed run silently fell back to the SDK
      // default, so continuing an Opus run could hand the rest of the task
      // to a different model mid-conversation.
      model: oldMeta.model,
      // Carries forward whatever the prior run had already claimed — a
      // follow-up must not look like it has never touched anything.
      claims: oldMeta.claims,
      resumedFrom: oldMeta.id,
      // The resumed run inherits the same worktree and the same BRANCH, so it
      // inherits the branch's stacking facts too. Dropping them here was how a
      // still-running resume ended up invisible to the merge queue: with no
      // `stackParents` it was never restacked and never flagged when its
      // blocker merged, and its stranded predecessor — still terminal, still
      // carrying the parents — looked like a safe restack target even though
      // this run's agent owns the worktree. `baseDiscarded` is deliberately
      // NOT inherited: the human asking for changes is the review action that
      // clears "a human needs to look at this".
      ...(oldMeta.stackParents !== undefined
        ? { stackParents: oldMeta.stackParents }
        : {}),
      ...(oldMeta.stackBaseCommit !== undefined
        ? { stackBaseCommit: oldMeta.stackBaseCommit }
        : {}),
    };
    this.registry.create(meta);
    this.transcriptFor(runId).writeHeader(meta);

    // The user's feedback is this run's opening conversation turn — record
    // it on the NEW run's transcript (mirroring the live-run branch of
    // sendMessage) so the follow-up chat opens showing what the user asked
    // for instead of an empty history. It still reaches the executor as the
    // start() prompt below; this entry is purely the transcript/UI record.
    const userEntry: NormalizedEntry = {
      ts: now,
      kind: 'message',
      from: 'user',
      text,
    };
    this.transcriptFor(runId).appendEntry(userEntry);
    this.ctx.events.broadcast({ type: 'run.log', runId, entry: userEntry });

    // Records the executor substitution as part of the same Activity line a
    // request-changes redispatch always writes, so the "why did this run end
    // up on a different executor" question is answered right there in the
    // task's own history rather than only in server logs.
    const substitutionNote = substituted
      ? ` (executor '${oldMeta.executor}' is no longer registered — substituted '${executorName}')`
      : '';
    this.ctx.store.update(
      oldMeta.taskId,
      {
        status: 'in-progress',
        appendActivity: `${now} requested changes (run ${runId}): ${text}${substitutionNote}`,
        activityActor: actor,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    this.transition(runId, 'running');
    const caps = this.orchestratorCaps();
    this.startAndRegister(
      runId,
      {
        cwd: meta.worktreePath,
        projectRoot: this.ctx.rootDir,
        runId,
        prompt: text,
        resumeSessionId: oldMeta.sessionId,
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
        model: oldMeta.model,
      },
      executor
    );
    return this.registry.get(runId)!;
  }

  // POST /api/runs/:id/resume: a fresh run in the SAME worktree/branch,
  // always a new session, with the run's survey (if any) in its prompt.
  resumeRun(runId: string): RunMeta {
    const meta = this.requireRun(runId);
    if (!TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorClientError(`run is still live: ${runId}`);
    }
    if (meta.reviewedAt !== undefined) {
      throw new OrchestratorConflictError(
        `run has already been reviewed: ${runId}`
      );
    }
    this.requireNoOpenPr(meta);
    // Same one-live-run-per-task rule dispatch()/sendMessage(resume) enforce
    // — a second resume racing this one would put two agents in one worktree.
    const live = this.registry.liveRunForTask(meta.taskId);
    if (live !== undefined) {
      throw new OrchestratorConflictError(
        `task already has a live run: ${live.id}`
      );
    }
    const task = this.ctx.store.get(meta.taskId);
    if (task === null) {
      throw new OrchestratorNotFoundError(`task not found: ${meta.taskId}`);
    }
    const {
      executor,
      name: executorName,
      substituted,
    } = this.resolveExecutorForResume(meta.executor);
    const now = new Date().toISOString();
    const newRunId = generateRunId(now);
    const basePrompt = this.promptForTask(task);
    const prompt =
      meta.survey !== undefined
        ? `${basePrompt}\n\n${renderSurveySection(meta.survey)}`
        : basePrompt;
    const newMeta: RunMeta = {
      id: newRunId,
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      executor: executorName,
      state: 'provisioning',
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      worktreePath: meta.worktreePath,
      createdAt: now,
      updatedAt: now,
      model: meta.model,
      // See requestChanges' matching comment — a resumed run keeps whatever
      // its predecessor had already claimed.
      claims: meta.claims,
      resumedFrom: meta.id,
      ...(meta.stackParents !== undefined
        ? { stackParents: meta.stackParents }
        : {}),
      ...(meta.stackBaseCommit !== undefined
        ? { stackBaseCommit: meta.stackBaseCommit }
        : {}),
    };
    this.registry.create(newMeta);
    this.transcriptFor(newRunId).writeHeader(newMeta);

    const substitutionNote = substituted
      ? ` (executor '${meta.executor}' is no longer registered — substituted '${executorName}')`
      : '';
    this.ctx.store.update(
      meta.taskId,
      {
        status: 'in-progress',
        appendActivity: `${now} resumed after ${meta.state} (run ${newRunId})${substitutionNote}`,
        // resumeRun() has exactly one caller: the human pressing Resume via
        // the API.
        activityActor: this.ctx.actorContext?.humanRef,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    this.transition(newRunId, 'running');
    const caps = this.orchestratorCaps();
    this.startAndRegister(
      newRunId,
      {
        cwd: newMeta.worktreePath,
        projectRoot: this.ctx.rootDir,
        runId: newRunId,
        prompt,
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
        model: meta.model,
      },
      executor
    );
    return this.registry.get(newRunId)!;
  }

  // Reads the project's `.dispatch/config.yml` `orchestrator:` block fresh on
  // every dispatch/resume — same rationale as the MCP tools re-resolving
  // config on every call: a config edit takes effect on the next dispatch
  // without a dispatchd restart.
  private orchestratorCaps(): OrchestratorConfig {
    return loadConfig(this.ctx.rootDir).orchestrator;
  }

  // Prompt handed to the executor: the task's own content plus its parent
  // epic's, assembled by the pure buildTaskPrompt() (see prompt.ts) so the
  // exact text is unit-testable independent of the orchestrator. A corrupt
  // parent epic file degrades to "no epic context" rather than failing the
  // whole dispatch — the task being dispatched is still perfectly valid.
  private promptForTask(task: TaskDoc): string {
    let parentEpic: TaskDoc | null = null;
    if (task.meta.parent !== null) {
      try {
        parentEpic = this.ctx.store.get(task.meta.parent);
      } catch (err) {
        if (!(err instanceof TaskParseError)) throw err;
      }
    }
    const ledgerEntries = this.ledgerStore.entriesFor(
      task.meta.id,
      task.meta.parent
    );
    return buildTaskPrompt(
      task,
      parentEpic,
      ledgerEntries,
      this.orientationFor(task.meta.id)
    );
  }

  // The repo facts injected into this task's prompt (see orientation.ts): the
  // workspace map, skills index, root scripts, cross-run file hotspots, the
  // cached repo map, and who else is running right now. Collecting reads a
  // handful of small files and this project's own transcripts; a failure
  // anywhere in there costs the section, never the dispatch, because a
  // throwing promptForTask strands the run in `provisioning`.
  private orientationFor(taskId: string): RepoOrientation | null {
    try {
      return collectOrientation({
        rootDir: this.ctx.rootDir,
        // Excluding this task's own runs is load-bearing, not tidiness:
        // dispatch() calls registry.create() and transitions the run to
        // `running` BEFORE building the prompt, so without this filter every
        // agent would open by reading that it is competing with itself over
        // its own claimed files.
        concurrentRuns: this.registry
          .list()
          .filter(
            (r) => !TERMINAL_RUN_STATES.has(r.state) && r.taskId !== taskId
          )
          .map((r) => ({
            id: r.id,
            taskTitle: r.taskTitle,
            claims: r.claims ?? [],
          })),
        digestCache: this.digestCache,
      });
    } catch (err) {
      console.error(
        `dispatchd: could not collect repo orientation: ${(err as Error).message}`
      );
      return null;
    }
  }
}
