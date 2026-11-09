import {
  claimConflictsWithWrites,
  describeJudgment,
  difficultyEligibility,
  difficultyPolicy,
  dispatchableTasks,
  fanoutHolder,
  hasStatusRole,
  loadConfig,
  projectPolicy,
  schedulableBatch,
} from '@dispatch-foo/core';
import type {
  DifficultyJudgment,
  DifficultyPolicy,
  TaskDoc,
} from '@dispatch-foo/core';

import type { EventBus } from './events.js';
import type { LedgerStorePort } from './ledger.js';
import type { RunMeta } from './orchestrator/types.js';
import {
  OrchestratorConflictError,
  TERMINAL_RUN_STATES,
} from './orchestrator/types.js';
import { statusModelFor } from './statuses.js';

/** The slices of the daemon the autopilot reads and drives, so tests can
 *  stand it up without worktrees or executors. */
export interface DifficultyAutopilotContext {
  rootDir: string;
  /** Every task, archived included (readiness needs every blocker). */
  tasks(): TaskDoc[];
  orchestrator: {
    list(): RunMeta[];
    liveClaims(): { claims: string[] }[];
    onRunTerminal(callback: (meta: RunMeta) => void): () => void;
    dispatchOrResume(
      taskId: string,
      request: {
        actor?: string;
        operator?: string | null;
        dispatchedBy?: string;
        guard?: (task: TaskDoc) => string | null;
      }
    ): Promise<unknown>;
  };
  events: Pick<EventBus, 'subscribe' | 'broadcast'>;
  /** The difficulty evaluator (judgments/difficulty.ts). */
  judge(task: TaskDoc): Promise<DifficultyJudgment | null>;
  /** The project's human: the dispatcher the runs are for, and the author
   *  of each receipt — the policy is their standing instruction. */
  humanRef: string;
  ledgerStore: Pick<LedgerStorePort, 'add'>;
  appendActivity(taskId: string, text: string): void;
  /** Tasks a live milestone session owns; the autopilot leaves those to it. */
  milestoneScope?: () => ReadonlySet<string>;
  /** How long after start() the first pass waits. Defaults to past the
   *  orchestrator's crash auto-resume, which must claim its runs first. */
  startDelayMs?: number;
  /** Trailing debounce on the board signals that trigger a pass. */
  debounceMs?: number;
}

const DEFAULT_START_DELAY_MS = 45_000;
const DEFAULT_DEBOUNCE_MS = 1_000;
/** Judgment requests one pass may spend: a fresh board of 200 tasks must not
 *  open 200 requests. Judgments are cached, so the next pass goes further. */
const MAX_JUDGMENTS_PER_PASS = 10;

/**
 * The difficulty autopilot: with `policy.difficulty.autoDispatch` on, it
 * dispatches ready, routine tasks the evaluator judges at or below the
 * threshold, up to `maxConcurrent` live runs of its own. From there the
 * policy engine's difficulty lift (policyEngine.ts) carries the run through
 * review and into the merge queue, so an easy task goes from `ready` to
 * landed without a human — and anything else stays exactly where it was.
 *
 * Candidates are deliberately narrow: the `ready` status role (not backlog),
 * unassigned or the project human's, never run before (a task a human
 * discarded or a run failed on wants a person, not a second unattended try),
 * clear of every live run's claims, and outside any live milestone session's
 * scope. Every dispatch writes a ledger decision and an Activity line naming
 * the judgment that authorized it. Driven by run terminals and task changes,
 * debounced, one pass at a time — never a poll.
 */
export class DifficultyAutopilot {
  // Tasks this autopilot dispatched, for its own concurrency count.
  private readonly dispatched = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private armed = false;
  private closed = false;

  constructor(private readonly ctx: DifficultyAutopilotContext) {}

  start(): () => void {
    const unsubscribeEvents = this.ctx.events.subscribe((event) => {
      if (event.type === 'task.changed') this.schedule();
    });
    const unsubscribeTerminal = this.ctx.orchestrator.onRunTerminal(() =>
      this.schedule()
    );
    const boot = setTimeout(() => {
      this.armed = true;
      this.schedule(0);
    }, this.ctx.startDelayMs ?? DEFAULT_START_DELAY_MS);
    return () => {
      this.closed = true;
      clearTimeout(boot);
      if (this.timer !== null) clearTimeout(this.timer);
      unsubscribeEvents();
      unsubscribeTerminal();
    };
  }

  /** One pass, awaited — for tests and the trailing re-run below. */
  async runOnce(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = this.fill()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `dispatchd: difficulty autopilot pass failed: ${message}`
        );
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
    // A signal that landed mid-pass may have freed a slot or readied a task.
    if (this.again && !this.closed) {
      this.again = false;
      await this.runOnce();
    }
  }

  private schedule(delay = this.ctx.debounceMs ?? DEFAULT_DEBOUNCE_MS): void {
    if (!this.armed || this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, delay);
  }

  private readPolicy(): DifficultyPolicy | null {
    try {
      return difficultyPolicy(projectPolicy(loadConfig(this.ctx.rootDir)));
    } catch {
      return null; // An unparseable config dispatches nothing.
    }
  }

  private async fill(): Promise<void> {
    const difficulty = this.readPolicy();
    if (difficulty === null || !difficulty.autoDispatch) return;

    const runs = this.ctx.orchestrator.list();
    const live = runs.filter(
      (r) => this.dispatched.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
    ).length;
    const slots = difficulty.maxConcurrent - live;
    if (slots <= 0) return;

    const candidates = this.candidates(runs);
    const chosen: { task: TaskDoc; judgment: DifficultyJudgment }[] = [];
    let judged = 0;
    for (const task of candidates) {
      if (chosen.length >= slots || judged >= MAX_JUDGMENTS_PER_PASS) break;
      // The cheap, judgment-free reasons first: no request for a task a
      // label or its risk already rules out.
      if (
        !difficultyEligibility(difficulty, 'dispatch', task.meta, {
          level: 'trivial',
          confidence: 1,
        }).eligible
      ) {
        continue;
      }
      judged++;
      const judgment = await this.ctx.judge(task);
      const eligibility = difficultyEligibility(
        difficulty,
        'dispatch',
        task.meta,
        judgment
      );
      if (eligibility.eligible)
        chosen.push({ task, judgment: eligibility.judgment });
    }
    if (chosen.length === 0) return;

    // No two overlapping `writes` in one batch, same as the milestone scheduler.
    const batch = new Set(
      schedulableBatch(
        chosen.map((c) => ({ id: c.task.meta.id, writes: c.task.meta.writes })),
        slots
      )
    );
    for (const { task, judgment } of chosen) {
      if (this.closed || !batch.has(task.meta.id)) continue;
      await this.dispatch(task, judgment, difficulty);
    }
  }

  // Ready, unheld, never-run tasks clear of live claims, highest readiness
  // first (dispatchableTasks' own order).
  private candidates(runs: RunMeta[]): TaskDoc[] {
    const statuses = statusModelFor(this.ctx.rootDir);
    const everRun = new Set(runs.map((r) => r.taskId));
    const milestoneScope = this.ctx.milestoneScope?.() ?? new Set<string>();
    const liveClaims = this.ctx.orchestrator.liveClaims().map((c) => c.claims);
    const human = this.ctx.humanRef;
    return dispatchableTasks(this.ctx.tasks(), statuses).filter(
      (t) =>
        hasStatusRole(t.meta.status, 'ready', statuses) &&
        !everRun.has(t.meta.id) &&
        !milestoneScope.has(t.meta.id) &&
        fanoutHolder(t.meta.assignee, human, human) === null &&
        !liveClaims.some((claim) =>
          claimConflictsWithWrites(claim, t.meta.writes)
        )
    );
  }

  private async dispatch(
    task: TaskDoc,
    judgment: DifficultyJudgment,
    difficulty: DifficultyPolicy
  ): Promise<void> {
    const id = task.meta.id;
    const statuses = statusModelFor(this.ctx.rootDir);
    const human = this.ctx.humanRef;
    // Re-asked of the task as it stands just before the run registers: an
    // edit or a teammate's claim between this pass's read and now wins.
    const guard = (current: TaskDoc): string | null => {
      if (!hasStatusRole(current.meta.status, 'ready', statuses)) {
        return `status is now ${current.meta.status}`;
      }
      const holder = fanoutHolder(current.meta.assignee, human, human);
      if (holder !== null) return `assigned to ${holder}`;
      const still = difficultyEligibility(
        difficulty,
        'dispatch',
        current.meta,
        judgment
      );
      return still.eligible ? null : still.reason;
    };
    try {
      await this.ctx.orchestrator.dispatchOrResume(id, {
        actor: 'none',
        operator: null,
        dispatchedBy: human,
        guard,
      });
    } catch (err) {
      // A run that appeared meanwhile, or a guard refusal, is a skip.
      if (err instanceof OrchestratorConflictError) return;
      throw err;
    }
    this.dispatched.add(id);
    const title = `${id} auto-dispatched as low difficulty`;
    const detail = `judged ${describeJudgment(judgment)}, within the ${difficulty.threshold} threshold, on routine risk, so it started in place of a dispatch click; label the task no-auto-land to keep it manual — auto-decided by the difficulty autopilot (policy.difficulty.autoDispatch)`;
    this.ctx.ledgerStore.add({
      milestoneId: task.meta.parent,
      sourceTaskId: id,
      kind: 'decision',
      title,
      detail,
      authoredBy: human,
    });
    this.ctx.events.broadcast({ type: 'ledger.changed' });
    this.ctx.appendActivity(
      id,
      `[policy] ${title} — judged ${describeJudgment(judgment)}, within the ${difficulty.threshold} threshold`
    );
  }
}
