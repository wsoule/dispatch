import type {
  ActorContext,
  FloorCheck,
  PolicyGate,
  PolicyRuling,
  TaskRisk,
  TaskStorePort,
} from '@dispatch/core';
import {
  consultPolicy,
  describeFloorHold,
  describePolicyAuthorization,
  loadConfig,
  projectPolicy,
} from '@dispatch/core';

import type { TaskCache } from './cache.js';
import type { DecisionPolicy } from './decisionFeed.js';
import type { EventBus } from './events.js';
import {
  budgetCapHolds,
  deletesOutsideDeclaredWrites,
  scopeRequestEscapesRepo,
} from './floor.js';
import type { LedgerStorePort } from './ledger.js';
import type { FixLoopState } from './orchestrator/fixLoop.js';
import type { ApprovalDecision, RunMeta } from './orchestrator/types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  runKind,
  TERMINAL_RUN_STATES,
} from './orchestrator/types.js';
import type {
  StartVerificationResult,
  VerificationResult,
} from './orchestrator/verify.js';

/**
 * The gate side of the policy engine (epic e-ad1978, ladder settled in
 * docs/design/autonomy-ladder.md): every existing human gate consults the
 * project's policy before parking work on a person. Below the task's
 * effective rung a gate blocks exactly as before; at or above it, the gate
 * auto-decides and RECORDS — the decision lands in the ledger and the task's
 * Activity carrying the rung that authorized it, and findings/evidence are
 * untouched.
 *
 * Policy is read fresh from .dispatch/config.yml on every consult (the same
 * per-use pattern the merge queue and fix loop use for their own config), so
 * editing the rung takes effect without a daemon restart. A config that does
 * not parse fails closed: every gate blocks. `risk` is the task's declared
 * risk, which caps the rung (core/policy.ts RISK_RUNG_CAPS).
 */
export function consultProjectPolicy(
  rootDir: string,
  gate: PolicyGate,
  risk?: TaskRisk
): PolicyRuling {
  try {
    return consultPolicy(projectPolicy(loadConfig(rootDir)), gate, risk);
  } catch {
    return { mode: 'block' };
  }
}

/**
 * The irreversibility floor's answer for one tool call: true means the call
 * is a floor action (force-push, publish, visibility change) that no rung may
 * auto-allow. Owned by the floor layer (t-4b72c5); the engine only asks.
 * While no detector is wired the approval gate never demotes at all — failing
 * closed is the only safe default for a gate that can run `git push --force`.
 */
export type ApprovalFloor = (toolName: string, input: unknown) => boolean;

// Which policy gate each decision-feed kind answers to. Feed kinds without an
// entry (questions, capped loops, stalled runs) always block — the fix loop's
// CAP in particular stays a human ruling at every rung; only the retries
// below it are automated.
const DECISION_KIND_GATES: Readonly<Record<string, PolicyGate>> = {
  'scope-request': 'scope',
  approval: 'approval',
};

export interface PolicyClassifierOptions {
  /** The declared risk of a task, so a critical task's items stay blocking. */
  riskOf?: (taskId: string) => TaskRisk | undefined;
  /** See ApprovalFloor. Absent: approvals are never `recorded`. */
  approvalFloor?: ApprovalFloor;
}

/**
 * The DecisionFeed classifier. An item still OPEN is always `blocking`: the
 * gates this engine demotes are decided the moment they arise (a scope
 * request at creation, an approval on its event), so anything left waiting
 * is by construction something policy declined — a path outside the repo, a
 * floor command, a critical task — and a human really is needed. An item
 * that has resolved under a demoted gate is `recorded`: worth knowing about,
 * nothing to act on.
 */
export function policyDecisionClassifier(
  rootDir: string,
  opts: PolicyClassifierOptions = {}
): DecisionPolicy {
  return (item) => {
    // The floor answers before any gate is looked up: an item floor.ts's
    // detectors claimed (`item.floor`) blocks unconditionally. The feed pins
    // it too, so a different classifier could not demote it either; this is
    // the classifier saying so itself, where the doc puts the floor.
    if (item.floor !== undefined) return 'blocking';
    if (item.state === 'open') return 'blocking';
    const gate = DECISION_KIND_GATES[item.kind];
    if (gate === undefined) return 'blocking';
    if (gate === 'approval' && opts.approvalFloor === undefined) {
      return 'blocking';
    }
    // A scope request outside the repo or into .git/ is the floor's own
    // pattern for this kind: never auto-granted, so never merely recorded.
    if (scopeRequestEscapesRepo(item.paths ?? []).length > 0) return 'blocking';
    const risk =
      item.taskId !== undefined ? opts.riskOf?.(item.taskId) : undefined;
    return consultProjectPolicy(rootDir, gate, risk).mode === 'auto'
      ? 'recorded'
      : 'blocking';
  };
}

/**
 * Appends one Activity line to a task the way the orchestrator narrates its
 * own mechanics (orchestrator.ts appendTaskActivity): timestamped, credited to
 * 'none' — the policy is the project's standing instruction, not a person
 * acting in the moment — and followed by the cache rebuild every task write
 * owes the read surfaces.
 */
export function policyActivityAppender(ctx: {
  store: TaskStorePort;
  cache: Pick<TaskCache, 'rebuild'>;
  events: Pick<EventBus, 'broadcast'>;
}): (taskId: string, text: string) => void {
  return (taskId, text) => {
    const now = new Date().toISOString();
    ctx.store.update(
      taskId,
      { appendActivity: `${now} ${text}`, activityActor: 'none' },
      now
    );
    ctx.cache.rebuild(ctx.store);
    ctx.events.broadcast({ type: 'task.changed' });
  };
}

// The slices of each peer this engine needs, DecisionFeed-style, so tests can
// exercise the hooks without standing up worktrees and executors.

interface PolicyEngineRuns {
  list(): RunMeta[];
  onRunTerminal(callback: (meta: RunMeta) => void): () => void;
  pendingApprovals(): {
    runId: string;
    taskId: string;
    requestId: string;
    toolName: string;
    input: unknown;
  }[];
  approve(runId: string, requestId: string, decision: ApprovalDecision): void;
  /** The run's working diff against its base — what auto-merge would land. */
  diff(runId: string): { files: { path: string; status: string }[] };
}

interface PolicyEngineFixLoop {
  get(taskId: string): FixLoopState | null;
  ignite(taskId: string): Promise<FixLoopState>;
}

interface PolicyEngineVerification {
  getLatestResult(taskId: string): VerificationResult | null;
  startVerification(opts: {
    taskId: string;
    head: string;
  }): Promise<StartVerificationResult>;
}

interface PolicyEngineMergeQueue {
  enqueue(runId: string): unknown;
}

interface PolicyEngineTasks {
  get(id: string): {
    meta: {
      parent: string | null;
      risk: TaskRisk;
      writes: string[];
      fixLoop?: boolean;
    };
  } | null;
}

export interface PolicyEngineContext {
  rootDir: string;
  store: PolicyEngineTasks;
  events: EventBus;
  orchestrator: PolicyEngineRuns;
  fixLoop: PolicyEngineFixLoop;
  verificationRunner: PolicyEngineVerification;
  mergeQueue: PolicyEngineMergeQueue;
  ledgerStore: LedgerStorePort;
  actorContext: Pick<ActorContext, 'humanRef'>;
  /** See ApprovalFloor. Absent: the approval gate never auto-allows. */
  approvalFloor?: ApprovalFloor;
  /** The Activity half of every receipt (policyActivityAppender). Optional
   *  so the ledger half still lands where no task store is wired. */
  appendActivity?: (taskId: string, text: string) => void;
}

// One line naming what a tool call asked for, for the receipt: the command
// for a shell tool, otherwise the input's JSON, either way cut to fit.
function describeToolInput(input: unknown): string {
  let text: string;
  if (typeof input === 'object' && input !== null && 'command' in input) {
    const { command } = input as { command: unknown };
    text = typeof command === 'string' ? command : JSON.stringify(input);
  } else {
    text = JSON.stringify(input) ?? String(input);
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`;
}

/**
 * Subscribes the approval, verify-retry and merge gates to the daemon's own
 * signals. (The scope gate needs no subscription: it is consulted inline
 * where the request is created — see api/scopeRequests.ts.)
 *
 * - A tool-approval escalation, at rung `approval`, is allowed on the spot
 *   unless the floor detector claims it.
 * - A finished implementer, at rung `verify-retry`, ignites the review→fix
 *   loop exactly as `fixLoop.auto: true` would (the two OR together, and a
 *   task's own `fixLoop: false` still opts out); a failed verification
 *   ignites it too. The loop's round cap bounds the retries and the cap
 *   itself still blocks.
 * - A completed fix loop whose task last verified red re-dispatches the
 *   verification — the actual retry the demotion promises.
 * - A fix loop settling `complete` — green, no standing rulings — at rung
 *   `merge` hands the task's latest implementer to the merge queue, whose
 *   existing green check (rebase, verifySteps, its GitHub holds) still decides
 *   when it lands. A loop that stopped `capped` never enqueues, and a run
 *   with no loop at all is not green.
 *
 * Two of the irreversibility floor's members (core/policy.ts) are states of
 * a run rather than commands, and this engine is where they bite: a task
 * with an unreviewed budget-exhausted run gets no auto-ignite or auto-retry,
 * and a run whose diff deletes outside its declared writes gets no
 * auto-enqueue — at every rung, with a ledger receipt saying why.
 */
export class PolicyEngine {
  // The failed-result timestamp each task's verify retry was dispatched for,
  // so repeated `fixloop.changed` broadcasts of an already-complete loop
  // cannot re-buy the same retry.
  private readonly retriedVerifications = new Map<string, string>();

  // Runs already handed to the merge queue by this engine, so the repeated
  // `fixloop.changed` broadcasts of one completed loop enqueue (and record)
  // once, not per event.
  private readonly enqueuedRuns = new Set<string>();

  // Floor holds already written to the ledger, keyed `<check>:<run id>`, so a
  // re-broadcast of the same signal records the hold once, not per event.
  // Not a hazard receipt's substitute: the ledger entry is the receipt the
  // epic promises — an auto-decision that did NOT happen, and why.
  private readonly recordedFloorHolds = new Set<string>();

  constructor(private readonly ctx: PolicyEngineContext) {}

  start(): () => void {
    const unsubscribeEvents = this.ctx.events.subscribe((event) => {
      if (event.type === 'verification.changed') {
        void this.onVerificationChanged(event.taskId).catch((err: unknown) => {
          this.logHookError('verify-retry', event.taskId, err);
        });
      }
      if (event.type === 'fixloop.changed') {
        void this.onFixLoopChanged(event.taskId).catch((err: unknown) => {
          this.logHookError('fix-loop-complete', event.taskId, err);
        });
      }
      if (event.type === 'approval.requested') {
        // Deferred one tick: the executor registers the request's resolver
        // right after it raises this event, so answering synchronously inside
        // the broadcast would answer a request nobody is listening for yet.
        void Promise.resolve().then(() => {
          try {
            this.onApprovalRequested(event.runId, event.requestId);
          } catch (err) {
            this.logHookError('approval', event.runId, err);
          }
        });
      }
    });
    const unsubscribeTerminal = this.ctx.orchestrator.onRunTerminal((meta) => {
      void this.onRunTerminal(meta).catch((err: unknown) => {
        this.logHookError('fix-loop-ignite', meta.taskId, err);
      });
    });
    return () => {
      unsubscribeEvents();
      unsubscribeTerminal();
    };
  }

  private logHookError(hook: string, id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `dispatchd: policy ${hook} hook for ${id} failed: ${message}`
    );
  }

  private riskOf(taskId: string): TaskRisk | undefined {
    return this.ctx.store.get(taskId)?.meta.risk;
  }

  // A tool call the SDK classifier referred to a human: at rung `approval`
  // the daemon answers it, unless the floor says this is an act no rung may
  // wave through. Without a floor detector wired nothing is ever auto-allowed.
  private onApprovalRequested(runId: string, requestId: string): void {
    const floor = this.ctx.approvalFloor;
    if (floor === undefined) return;
    const pending = this.ctx.orchestrator
      .pendingApprovals()
      .find((a) => a.runId === runId && a.requestId === requestId);
    if (pending === undefined) return;
    const ruling = consultProjectPolicy(
      this.ctx.rootDir,
      'approval',
      this.riskOf(pending.taskId)
    );
    if (ruling.mode !== 'auto') return;
    if (floor(pending.toolName, pending.input)) return;
    try {
      this.ctx.orchestrator.approve(runId, requestId, { allow: true });
    } catch (err) {
      // A human answered first, or the run moved on: nothing to record.
      if (err instanceof OrchestratorClientError) return;
      throw err;
    }
    this.record(
      ruling,
      pending.taskId,
      `Tool approval auto-allowed for run ${runId}`,
      `${pending.toolName}: ${describeToolInput(pending.input)}`
    );
  }

  // A finished implementer at rung `verify-retry`: open the review→fix loop
  // the way `fixLoop.auto` would. When that config switch is on, the fix loop
  // engine already ignites on this same signal and no policy decision was
  // made, so there is nothing to record here.
  private async onRunTerminal(meta: RunMeta): Promise<void> {
    if (runKind(meta) !== 'execute' || meta.state !== 'finished') return;
    if (this.configAutoIgnites()) return;
    await this.igniteFixLoop(
      meta.taskId,
      `Review & fix loop auto-started for ${meta.taskId}`,
      `implementer run ${meta.id} finished; the loop was ignited in place of a "Review & fix" click, and its round cap still bounds the retries`
    );
  }

  private configAutoIgnites(): boolean {
    try {
      return loadConfig(this.ctx.rootDir).fixLoop.auto;
    } catch {
      return false;
    }
  }

  // A failed verification at rung `verify-retry`: open the fix loop the human
  // would have opened. An already-open loop owns its own retries, and a
  // capped one is waiting on a ruling the policy must not bypass.
  private async onVerificationChanged(taskId: string): Promise<void> {
    const result = this.ctx.verificationRunner.getLatestResult(taskId);
    if (result === null || result.pass) return;
    await this.igniteFixLoop(
      taskId,
      `Verify retry auto-started for ${taskId}`,
      `verification run ${result.runId} failed; the fix loop was ignited in place of a human review request, and its round cap still bounds the retries`
    );
  }

  // The shared ignition behind both rung-3 triggers. A task that opted out of
  // the automatic loop (`fixLoop: false`) keeps the human button; an existing
  // loop, open or capped, is left to its own machinery.
  private async igniteFixLoop(
    taskId: string,
    title: string,
    detail: string
  ): Promise<void> {
    const task = this.ctx.store.get(taskId);
    if (task === null || task.meta.fixLoop === false) return;
    const ruling = consultProjectPolicy(
      this.ctx.rootDir,
      'verify-retry',
      task.meta.risk
    );
    if (ruling.mode !== 'auto') return;
    if (this.budgetFloorHolds(taskId, 'fix loop auto-ignite')) return;
    if (this.ctx.fixLoop.get(taskId) !== null) return;
    try {
      await this.ctx.fixLoop.ignite(taskId);
    } catch (err) {
      // Nothing to review (no implementer, no commits, a standing block) is a
      // quiet decline, not a failure — the manual route stays open.
      if (err instanceof OrchestratorClientError) return;
      throw err;
    }
    this.record(ruling, taskId, title, detail);
  }

  // A fix loop settling `complete`: re-verify if the task last verified red
  // (rung 3), then hand the run to the merge queue (rung 4). Any other loop
  // state — open rounds, or capped on a ruling — is not green.
  private async onFixLoopChanged(taskId: string): Promise<void> {
    const loop = this.ctx.fixLoop.get(taskId);
    if (loop === null || loop.state !== 'complete') return;
    const result = this.ctx.verificationRunner.getLatestResult(taskId);
    if (result !== null && !result.pass) {
      await this.retryVerification(taskId, result);
    }
    const latest = this.latestFinishedExecuteRun(taskId);
    if (latest !== null) this.enqueueForMerge(latest);
  }

  private async retryVerification(
    taskId: string,
    failed: VerificationResult
  ): Promise<void> {
    const ruling = consultProjectPolicy(
      this.ctx.rootDir,
      'verify-retry',
      this.riskOf(taskId)
    );
    if (ruling.mode !== 'auto') return;
    if (this.budgetFloorHolds(taskId, 'verification auto-retry')) return;
    if (this.retriedVerifications.get(taskId) === failed.createdAt) return;
    if (this.hasLiveVerifyRun(taskId)) return;
    const run = this.latestFinishedExecuteRun(taskId);
    if (run === null) return;
    const started = await this.ctx.verificationRunner.startVerification({
      taskId,
      head: run.branch,
    });
    if (started.skipped) return;
    this.retriedVerifications.set(taskId, failed.createdAt);
    this.record(
      ruling,
      taskId,
      `Verification auto-retried for ${taskId}`,
      `run ${failed.runId} verified red, the fix loop completed, and run ${started.meta.id} now re-verifies ${run.branch}`
    );
  }

  private hasLiveVerifyRun(taskId: string): boolean {
    return this.ctx.orchestrator
      .list()
      .some(
        (run) =>
          run.taskId === taskId &&
          runKind(run) === 'verify' &&
          !TERMINAL_RUN_STATES.has(run.state)
      );
  }

  // orchestrator.list() is most-recent-first, so the first match is the
  // task's latest finished implementer.
  private latestFinishedExecuteRun(taskId: string): RunMeta | null {
    return (
      this.ctx.orchestrator
        .list()
        .find(
          (run) =>
            run.taskId === taskId &&
            runKind(run) === 'execute' &&
            run.state === 'finished'
        ) ?? null
    );
  }

  private enqueueForMerge(meta: RunMeta): void {
    if (this.enqueuedRuns.has(meta.id)) return;
    const ruling = consultProjectPolicy(
      this.ctx.rootDir,
      'merge',
      this.riskOf(meta.taskId)
    );
    if (ruling.mode !== 'auto') return;
    if (this.deletesOutsideWritesHold(meta)) return;
    try {
      this.ctx.mergeQueue.enqueue(meta.id);
    } catch (err) {
      // The queue's own admission rules — already queued, already reviewed,
      // a finding a human ruled unshippable — are gates the policy rides,
      // not failures: declining quietly leaves the run for a person.
      if (err instanceof OrchestratorConflictError) return;
      throw err;
    }
    this.enqueuedRuns.add(meta.id);
    this.record(
      ruling,
      meta.taskId,
      `Run ${meta.id} auto-enqueued for merge`,
      `its fix loop completed green and run ${meta.id} entered the merge queue; the queue's existing green check still gates landing`
    );
  }

  // The floor's budget-cap member on the spend paths: while the task has a run
  // that died on its cost cap and nobody has reviewed, archived or resumed,
  // nothing spends on the task's behalf. Deciding to spend past the cap is a
  // human ruling at every rung — a resume IS that ruling, and lifts the hold.
  private budgetFloorHolds(taskId: string, action: string): boolean {
    const holds = budgetCapHolds(this.ctx.orchestrator.list(), taskId);
    if (holds.length === 0) return false;
    for (const run of holds) {
      this.recordFloorHold(
        'budget-cap',
        run.id,
        taskId,
        `${action} held for ${taskId}`,
        `run ${run.id} hit its cost budget and has not been reviewed, so policy did not ${action}; more spend is a human decision`
      );
    }
    return true;
  }

  // The floor's delete-outside-writes member on auto-merge: a run whose diff
  // deletes a file no declared write covers never enters the queue on policy's
  // say-so. A diff that cannot be read (no worktree, no snapshot) is held as
  // well — the floor errs toward a needless question, never a silent landing.
  private deletesOutsideWritesHold(meta: RunMeta): boolean {
    const writes = this.ctx.store.get(meta.taskId)?.meta.writes ?? [];
    let deleted: string[];
    try {
      deleted = deletesOutsideDeclaredWrites(
        writes,
        this.ctx.orchestrator.diff(meta.id).files
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `dispatchd: policy merge hook could not read the diff of ${meta.id}, holding it for a human: ${message}`
      );
      return true;
    }
    if (deleted.length === 0) return false;
    this.recordFloorHold(
      'delete-outside-writes',
      meta.id,
      meta.taskId,
      `Run ${meta.id} held from auto-merge`,
      `its diff deletes ${deleted.join(', ')} outside the task's declared writes, so policy did not enqueue it`
    );
    return true;
  }

  // The receipt for a hold: the same ledger decision an auto-decision writes,
  // phrased with the floor member that stopped it, once per (check, run).
  private recordFloorHold(
    check: FloorCheck,
    runId: string,
    taskId: string,
    title: string,
    detail: string
  ): void {
    const key = `${check}:${runId}`;
    if (this.recordedFloorHolds.has(key)) return;
    this.recordedFloorHolds.add(key);
    const task = this.ctx.store.get(taskId);
    this.ctx.ledgerStore.add({
      epicId: task?.meta.parent ?? null,
      sourceTaskId: taskId,
      kind: 'decision',
      title,
      detail: `${detail} — ${describeFloorHold(check)}`,
      authoredBy: this.ctx.actorContext.humanRef,
    });
    this.ctx.events.broadcast({ type: 'ledger.changed' });
  }

  // The receipt, both halves: a ledger decision like the one the human would
  // have produced, and an Activity line on the task — each carrying the rung
  // that authorized it. Attributed to the project's human, whose standing
  // instruction the policy is, with the authorization line marking it as
  // auto-decided; findings and evidence untouched.
  private record(
    ruling: Extract<PolicyRuling, { mode: 'auto' }>,
    taskId: string,
    title: string,
    detail: string
  ): void {
    const authorization = describePolicyAuthorization(ruling);
    const task = this.ctx.store.get(taskId);
    this.ctx.ledgerStore.add({
      epicId: task?.meta.parent ?? null,
      sourceTaskId: taskId,
      kind: 'decision',
      title,
      detail: `${detail} — ${authorization}`,
      authoredBy: this.ctx.actorContext.humanRef,
    });
    this.ctx.events.broadcast({ type: 'ledger.changed' });
    this.ctx.appendActivity?.(taskId, `[policy] ${title} — ${authorization}`);
  }
}
