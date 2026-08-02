import { loadConfig } from '@dispatch/core';
import type {
  EscalationStep,
  Finding,
  TaskDoc,
  TaskStore,
} from '@dispatch/core';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { FindingStore } from '../findings.js';
import type { Orchestrator } from './orchestrator.js';
import type { ReviewRunner } from './review.js';
import type { RunKind, RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorNotFoundError,
  runKind,
  TERMINAL_RUN_STATES,
} from './types.js';
import { WorktreeManager } from './worktree.js';

export type { EscalationStep } from '@dispatch/core';

/** The label a blocking ruling puts on the task, so it is visible on the board
 *  rather than only inside the finding that caused it. */
export const BLOCKED_LABEL = 'blocked';

export type FixLoopVerdict = 'parked' | 'blocked';

export interface FixLoopState {
  taskId: string;
  /** 0 = not started. Incremented once per dispatched fix. */
  round: number;
  cap: number;
  state: 'idle' | 'implementing' | 'reviewing' | 'capped' | 'complete';
  /** The commit before the task's first implementer. Every round is reviewed
   *  against it, so a later round sees the whole change, not just its own. */
  baseSha: string;
  lastReviewedSha: string | null;
  updatedAt: string;
}

// Per-task loop state in `.dispatch/fix-loops.jsonl`, one JSON line per write.
// Last line for a task id wins, like FindingStore.
export class FixLoopStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'fix-loops.jsonl');
  }

  private read(): Map<string, FixLoopState> {
    const byTask = new Map<string, FixLoopState>();
    if (!existsSync(this.file)) return byTask;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as FixLoopState;
        byTask.set(record.taskId, record);
      } catch {
        // A hand-corrupted line costs itself, not the rest of the store.
      }
    }
    return byTask;
  }

  get(taskId: string): FixLoopState | null {
    return this.read().get(taskId) ?? null;
  }

  list(): FixLoopState[] {
    return [...this.read().values()];
  }

  put(state: FixLoopState): FixLoopState {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(state)}\n`);
    return state;
  }
}

// The rung governing `round`: the latest row at or below it, falling back to
// the conservative default so an empty or short table never stalls the loop.
export function escalationFor(
  round: number,
  table: readonly EscalationStep[]
): EscalationStep {
  let chosen: EscalationStep | null = null;
  for (const step of table) {
    if (step.round > round) continue;
    if (chosen === null || step.round >= chosen.round) chosen = step;
  }
  if (chosen === null)
    return { round, strategy: 'resume', modelTier: 'standard' };
  return { round, strategy: chosen.strategy, modelTier: chosen.modelTier };
}

export interface FixPromptInput {
  task: TaskDoc;
  round: number;
  cap: number;
  strategy: EscalationStep['strategy'];
  findings: Finding[];
}

// The instruction a fix run receives. Findings are rendered verbatim — a
// paraphrase is where a fix round starts solving the wrong problem.
export function buildFixPrompt(input: FixPromptInput): string {
  const { meta } = input.task;
  const lines: string[] = [
    `# Fix round ${input.round} of ${input.cap} — ${meta.id}: ${meta.title}`,
  ];
  if (input.strategy === 'fresh') {
    lines.push(
      'You are a fresh implementer picking up work someone else started. The' +
        ' rounds before you patched around the findings below without clearing' +
        ' them. Attack the design, not the symptoms — replacing the mechanism' +
        ' is on the table, and so is the possibility that the current shape is' +
        ' hiding the real defect.'
    );
  } else {
    lines.push('A review of this work raised the findings below.');
  }
  lines.push('', '## Open findings');
  for (const finding of input.findings) {
    lines.push(
      '',
      `### [${finding.id}] ${finding.severity} — ${finding.title}`
    );
    if (finding.file !== null) {
      lines.push(
        finding.line !== null ? `${finding.file}:${finding.line}` : finding.file
      );
    }
    lines.push('', finding.detail);
  }
  lines.push(
    '',
    '## What to do',
    '- Address every finding above, or state precisely why one is not a defect.',
    '- Commit your work. An uncommitted fix is not reviewable and this round' +
      ' is judged on what is committed to the branch.',
    '- Do not widen the change beyond what these findings require.'
  );
  return lines.join('\n');
}

export interface FixLoopContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  reviewRunner: ReviewRunner;
  findingStore: FindingStore;
  fixLoopStore: FixLoopStore;
}

/** The review -> fix -> re-review loop. Its cap does not resolve itself: a
 *  capped loop waits for a written ruling on every finding still open. */
export class FixLoop {
  private readonly worktrees: WorktreeManager;
  // One advance at a time per task: two concurrent calls would each read the
  // same state and dispatch the same round twice.
  private readonly inFlight = new Map<string, Promise<FixLoopState>>();

  constructor(private readonly ctx: FixLoopContext) {
    this.worktrees = new WorktreeManager(ctx.rootDir);
    // Registered after ReviewRunner's own terminal hook (see index.ts) so a
    // review's findings are already in the store when this fires for that run.
    ctx.orchestrator.onRunTerminal((meta) => {
      if (this.ctx.fixLoopStore.get(meta.taskId) === null) return;
      void this.advance(meta.taskId).catch((err: unknown) => {
        console.error(
          `dispatchd: fix loop for ${meta.taskId} failed to advance: ${String(err)}`
        );
      });
    });
  }

  get(taskId: string): FixLoopState | null {
    return this.ctx.fixLoopStore.get(taskId);
  }

  // Opens the loop for a task. `baseSha` is supplied by the caller that knows
  // where the task's first implementer started, and never moves afterwards.
  start(taskId: string, opts: { baseSha: string; cap?: number }): FixLoopState {
    const existing = this.ctx.fixLoopStore.get(taskId);
    if (existing !== null) return existing;
    this.requireTask(taskId);
    return this.save({
      taskId,
      round: 0,
      cap: opts.cap ?? loadConfig(this.ctx.rootDir).fixLoop.cap,
      state: 'idle',
      baseSha: opts.baseSha,
      lastReviewedSha: null,
      updatedAt: '',
    });
  }

  // Drives the loop one step from whatever state it is in. Calls chain rather
  // than interleave, and a step with nothing to do returns the state unchanged.
  async advance(taskId: string): Promise<FixLoopState> {
    const previous = this.inFlight.get(taskId);
    const next = (previous ?? Promise.resolve()).then(
      () => this.step(taskId),
      () => this.step(taskId)
    );
    this.inFlight.set(taskId, next);
    try {
      return await next;
    } finally {
      if (this.inFlight.get(taskId) === next) this.inFlight.delete(taskId);
    }
  }

  // The explicit ruling the cap demands. `ruling` is required and non-empty: a
  // parked finding with no stated reason is a silent discard.
  adjudicate(
    taskId: string,
    findingId: string,
    verdict: FixLoopVerdict,
    ruling: string
  ): Finding {
    const finding = this.ctx.findingStore.get(findingId);
    if (finding === null || finding.taskId !== taskId) {
      throw new OrchestratorNotFoundError(
        `finding not found on ${taskId}: ${findingId}`
      );
    }
    if (ruling.trim() === '') {
      throw new OrchestratorClientError('invalid ruling: ruling is required');
    }
    const updated = this.ctx.findingStore.update(findingId, {
      verdict,
      ruling: ruling.trim(),
    });
    this.ctx.events.broadcast({ type: 'finding.changed' });
    if (verdict === 'blocked') this.blockTask(taskId, updated);
    return updated;
  }

  private async step(taskId: string): Promise<FixLoopState> {
    const state = this.ctx.fixLoopStore.get(taskId);
    if (state === null) {
      throw new OrchestratorNotFoundError(`no fix loop for task: ${taskId}`);
    }
    switch (state.state) {
      case 'complete':
        return state;
      case 'capped':
        return this.settleCapped(state);
      case 'implementing':
        return await this.afterFixRun(state);
      case 'reviewing':
        return await this.afterReviewRun(state);
      default:
        return await this.openRound(state);
    }
  }

  // The one place a round is opened: clean means done, a full cap means stop,
  // and anything else dispatches the next fix.
  private async openRound(state: FixLoopState): Promise<FixLoopState> {
    const open = this.ctx.findingStore.openFor(state.taskId);
    if (open.length === 0) return this.save({ ...state, state: 'complete' });
    if (state.round >= state.cap) return this.reachCap(state);
    const round = state.round + 1;
    const step = escalationFor(
      round,
      loadConfig(this.ctx.rootDir).fixLoop.escalation
    );
    await this.dispatchFix(state, step, open);
    return this.save({ ...state, round, state: 'implementing' });
  }

  private async dispatchFix(
    state: FixLoopState,
    step: EscalationStep,
    open: Finding[]
  ): Promise<void> {
    const task = this.requireTask(state.taskId);
    const prompt = buildFixPrompt({
      task,
      round: step.round,
      cap: state.cap,
      strategy: step.strategy,
      findings: open,
    });
    const previous = this.latestRun(state.taskId, 'execute');
    if (
      step.strategy === 'resume' &&
      previous !== null &&
      previous.sessionId !== undefined &&
      previous.sessionId !== ''
    ) {
      this.ctx.orchestrator.sendMessage(previous.id, prompt, { resume: true });
      return;
    }
    // A fresh implementer starts from the work so far rather than the task's
    // base: it is replacing an approach, not redoing the task from scratch.
    await this.ctx.orchestrator.dispatchAuxRun({
      taskId: state.taskId,
      kind: 'execute',
      head: previous?.branch ?? state.baseSha,
      model: this.modelFor(task, step.modelTier),
      buildPrompt: () => prompt,
    });
  }

  // `standard` keeps the task's own tier; `high` overrides a cheaper per-task
  // model with the project's execute model, which is the point of escalating.
  private modelFor(task: TaskDoc, tier: EscalationStep['modelTier']): string {
    const { models } = loadConfig(this.ctx.rootDir);
    return tier === 'high'
      ? models.execute
      : (task.meta.model ?? models.execute);
  }

  private async afterFixRun(state: FixLoopState): Promise<FixLoopState> {
    const run = this.latestRun(state.taskId, 'execute');
    if (run === null || !TERMINAL_RUN_STATES.has(run.state)) return state;
    // Re-reviewed even when the fix run failed: the review judges the branch,
    // so a fix that did nothing costs a round rather than wedging the loop.
    const head = this.worktrees.resolveCommit(run.branch);
    await this.ctx.reviewRunner.startReview({
      taskId: state.taskId,
      base: state.baseSha,
      head,
      round: state.round,
      scope: 'fix',
      openFindings: this.ctx.findingStore.openFor(state.taskId),
    });
    return this.save({ ...state, state: 'reviewing', lastReviewedSha: head });
  }

  private async afterReviewRun(state: FixLoopState): Promise<FixLoopState> {
    const run = this.latestRun(state.taskId, 'review');
    if (run === null || !TERMINAL_RUN_STATES.has(run.state)) return state;
    // Only a review that actually finished clears anything. A failed one (an
    // unusable findings payload) must never read as a clean result.
    if (run.state === 'finished') this.closeInputFindings(state.taskId, run.id);
    return await this.openRound(state);
  }

  // Anything the finished review did not itself raise was an input to the fix
  // it judged, so it is addressed — what survives comes back as a new finding.
  private closeInputFindings(taskId: string, reviewRunId: string): void {
    let closed = 0;
    for (const finding of this.ctx.findingStore.openFor(taskId)) {
      if (finding.runId === reviewRunId) continue;
      this.ctx.findingStore.update(finding.id, { verdict: 'addressed' });
      closed += 1;
    }
    if (closed > 0) this.ctx.events.broadcast({ type: 'finding.changed' });
  }

  private reachCap(state: FixLoopState): FixLoopState {
    const saved = this.save({ ...state, state: 'capped' });
    this.ctx.events.broadcast({
      type: 'fixloop.capped',
      taskId: saved.taskId,
      round: saved.round,
    });
    return saved;
  }

  // The cap never resolves itself. The loop completes only once every finding
  // carries a written ruling and none of them blocks.
  private settleCapped(state: FixLoopState): FixLoopState {
    if (this.ctx.findingStore.openFor(state.taskId).length > 0) return state;
    const blocked = this.ctx.findingStore.list({
      taskId: state.taskId,
      verdict: 'blocked',
    });
    if (blocked.length > 0) return state;
    return this.save({ ...state, state: 'complete' });
  }

  // Core has no `blocked` status (a project's statuses are pinned in its own
  // config), so this hands the task to a human, labels it, and records why.
  private blockTask(taskId: string, finding: Finding): void {
    const task = this.requireTask(taskId);
    const now = new Date().toISOString();
    const labels = task.meta.labels.includes(BLOCKED_LABEL)
      ? task.meta.labels
      : [...task.meta.labels, BLOCKED_LABEL];
    this.ctx.store.update(
      taskId,
      {
        assignee: 'human',
        labels,
        appendActivity: `${now} blocked by finding ${finding.id}: ${finding.ruling ?? ''}`,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  private latestRun(taskId: string, kind: RunKind): RunMeta | null {
    const runs = this.ctx.orchestrator
      .list()
      .filter((run) => run.taskId === taskId && runKind(run) === kind)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return runs.at(-1) ?? null;
  }

  private requireTask(taskId: string): TaskDoc {
    const task = this.ctx.store.get(taskId);
    if (task === null) {
      throw new OrchestratorNotFoundError(`task not found: ${taskId}`);
    }
    return task;
  }

  private save(state: FixLoopState): FixLoopState {
    const saved = this.ctx.fixLoopStore.put({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    this.ctx.events.broadcast({
      type: 'fixloop.changed',
      taskId: saved.taskId,
    });
    return saved;
  }
}
