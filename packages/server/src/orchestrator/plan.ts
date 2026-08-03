import { generateDraftId, loadConfig } from '@dispatch/core';
import type { ActorContext, TaskStore } from '@dispatch/core';
import { createHash, randomBytes } from 'node:crypto';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type {
  PlannedTask,
  Planner,
  PlannerQuestion,
  PlannerTurn,
  PlanProposal,
} from './planner.js';
import { validatePlanProposal, validatePlanProposalOrNull } from './planner.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';

// Same shape as core's generateRunId (a short collision-resistant hex tag),
// but kept local to the server package rather than added to @dispatch/core —
// unlike tasks/runs, a plan is a purely server-side, in-memory concept (see
// PlanManager's doc comment) that is never written to a task file, so it has
// no reason to live alongside core's on-disk id schemes.
function generatePlanId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `plan-${hash}`;
}

// `running` means a turn (the opening one or a follow-up) is currently in
// flight; `ready` means the last turn settled and `proposal` holds a working
// proposal that can be refined further or confirmed; `failed` means the last
// turn errored.
export type PlanState = 'running' | 'ready' | 'failed';

// One entry in a plan's conversation transcript: a `user` message (the opening
// prompt or a follow-up) or the `assistant` reply that answered it.
export interface PlanMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface PlanRecord {
  id: string;
  // The opening prompt that started this conversation. Kept alongside
  // `messages[0]` (which is the same text) as a convenience for callers that
  // only want the plan's original ask.
  prompt: string;
  // Which registered planner this plan is talking to. Stored so a follow-up
  // (sendMessage) re-resolves the same planner the opening turn used — a plan
  // is one continuous conversation with one backend.
  plannerName: string;
  // Which config.models role resolves this conversation's model ('enrich' for
  // api.ts's enrich* flows). Stored so follow-ups re-read the same role.
  role: 'plan' | 'enrich';
  state: PlanState;
  // The full conversation transcript, appended to on every turn: the user
  // message first, then the assistant reply once the turn settles.
  messages: PlanMessage[];
  // The latest *working* proposal — refined across turns and the target
  // confirm() validates against. Undefined until the first turn settles ready.
  proposal?: PlanProposal;
  // Clarifying questions from the latest assistant turn, answerable via
  // sendMessage; empty once the planner has enough to propose without them.
  questions: PlannerQuestion[];
  // The planner's opaque resume handle from the most recent turn (the Agent
  // SDK session id for ClaudePlanner). Threaded back into the next
  // sendMessage so follow-ups retain prior context.
  sessionId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  // Set once /confirm has successfully written the epic+tasks for this plan
  // — the one-way marker double-confirm's 409 check reads (mirrors RunMeta's
  // own reviewedAt marker in orchestrator/types.ts).
  confirmedAt?: string;
  // Set when this plan was started from a note (POST /api/notes/:id/enrich)
  // rather than a free-form prompt: the note whose one-liner the planner was
  // asked to expand into a real task. PlanManager itself never reads it —
  // it exists so api.ts can link that note to the task confirm() creates,
  // the same linkage the plain promote path writes.
  sourceNoteId?: string;
}

export interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
}

// One in-flight or settled task draft, mirroring PlanRecord's shape.
// In-memory only — a lost daemon losing in-flight drafts is acceptable.
export interface DraftRecord {
  id: string;
  prompt: string;
  // Which registered planner this draft is talking to (mirrors PlanRecord.plannerName).
  plannerName: string;
  state: 'running' | 'ready' | 'failed';
  /** The planner's conversational reply for this turn (may contain questions). */
  message: string;
  proposal: PlanProposal | null;
  /** Clarifying questions from the latest turn, answerable via sendDraftMessage. */
  questions: PlannerQuestion[];
  // The planner's opaque resume handle from the most recent turn, threaded
  // into the next sendDraftMessage — mirrors PlanRecord.sessionId.
  sessionId?: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// Cap on how many drafts stay in memory at once; eviction only drops
// *non-running* entries once exceeded (see evictOldDrafts).
const MAX_DRAFTS = 50;

export interface PlanManagerContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  // Optional, same "tests may omit it" contract as OrchestratorContext's own
  // field — confirm() below falls back to an unattributed Activity line when
  // it's absent.
  actorContext?: ActorContext;
}

// Builds the markdown body TaskStore.create's `description` param receives
// for one planned task: the planner/proposal's own description, followed by
// a plain "Acceptance criteria" bullet list when the proposal supplied any.
// Deliberately does not emit its own "## Acceptance Criteria" heading — the
// store's create() template already appends an (empty) one of those after
// whatever description text is given, and a second heading of the same
// level would just look duplicated for no benefit.
function buildTaskDescription(task: PlannedTask): string {
  const parts = [task.description.trim()];
  if (task.acceptanceCriteria.length > 0) {
    parts.push(
      'Acceptance criteria:',
      task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

/**
 * Owns the plan/confirm half of Phase 5's big-prompt flow (spec §5): drives a
 * `Planner` as a multi-turn conversation — an opening `startPlan` prompt plus
 * any number of `sendMessage` follow-ups that refine the working proposal —
 * tracking each turn's running -> ready|failed state, the message history, and
 * the latest working proposal in a small in-memory registry (machine-local —
 * a plan that was still `running` when dispatchd restarts is simply gone, same
 * as the epic engine's own state; nothing here is durable the way run
 * transcripts are), and, on confirm, re-validates the (client-editable)
 * proposal from scratch and
 * writes it via TaskStore: the epic first (if any), then every task with its
 * `parent` and `blockedBy` wired from proposal indices to the real ids
 * TaskStore just minted. Proposals are NEVER written without an explicit
 * confirm call — this class is the one place that rule is enforced.
 *
 * Phase 7: planners are registered by name (mirrors Orchestrator's own
 * `registerExecutor`/`registeredExecutorNames` pair) rather than the class
 * being handed one fixed `Planner` — this is what lets `POST /api/plan`
 * accept an optional `planner` field with the exact same "unknown name is a
 * 400 naming every valid option" contract `executor` already has on
 * `POST /api/tasks/:id/runs`, which in turn is what makes the CLI's
 * `dispatch plan --planner claude|fake` a real per-request choice instead of
 * a fixed, whole-server setting.
 */
export class PlanManager {
  private readonly plans = new Map<string, PlanRecord>();
  private readonly planners = new Map<string, Planner>();
  private readonly drafts = new Map<string, DraftRecord>();

  constructor(private readonly ctx: PlanManagerContext) {}

  registerPlanner(name: string, planner: Planner): void {
    this.planners.set(name, planner);
  }

  // api.ts derives its "is this planner name even valid" 400 message from
  // exactly what's registered here, same as Orchestrator.registeredExecutorNames().
  registeredPlannerNames(): string[] {
    return [...this.planners.keys()];
  }

  // Fresh per-call read of `config.models`, so a settings change takes effect
  // on the very next call with no daemon restart.
  private resolveModel(role: 'plan' | 'enrich'): string {
    const { models } = loadConfig(this.ctx.rootDir);
    return role === 'enrich' ? models.enrich : models.plan;
  }

  // Opens a plan conversation and returns its id immediately; the Planner call
  // is fire-and-forget, landing via runTurn()'s `plan.changed` broadcast.
  startPlan(
    prompt: string,
    plannerName = 'claude',
    sourceNoteId?: string,
    role: 'plan' | 'enrich' = 'plan'
  ): PlanRecord {
    const planner = this.planners.get(plannerName);
    if (planner === undefined) {
      throw new OrchestratorClientError(`unknown planner: ${plannerName}`);
    }
    const now = new Date().toISOString();
    const record: PlanRecord = {
      id: generatePlanId(now),
      prompt,
      plannerName,
      role,
      state: 'running',
      messages: [{ role: 'user', text: prompt, at: now }],
      questions: [],
      createdAt: now,
      updatedAt: now,
      sourceNoteId,
    };
    this.plans.set(record.id, record);
    const model = this.resolveModel(role);
    void this.runTurn(record.id, () => planner.start(prompt, model, 'plan'));
    return record;
  }

  // Starts a single-task draft's planner turn in the background and returns
  // the DraftRecord immediately at `running`; no busy-guard between drafts.
  startDraft(prompt: string, plannerName = 'claude'): DraftRecord {
    const planner = this.planners.get(plannerName);
    if (planner === undefined) {
      throw new OrchestratorClientError(`unknown planner: ${plannerName}`);
    }
    const now = new Date().toISOString();
    const record: DraftRecord = {
      id: generateDraftId(now),
      prompt,
      plannerName,
      state: 'running',
      message: '',
      proposal: null,
      questions: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.drafts.set(record.id, record);
    this.evictOldDrafts();
    const model = loadConfig(this.ctx.rootDir).models.draft;
    void this.runDraftTurn(record.id, () =>
      planner.start(prompt, model, 'draft')
    );
    return record;
  }

  // Mirrors sendMessage for a draft's follow-up (typically an answer to its
  // questions), minus the `confirmedAt` guard — a draft has no confirm step.
  sendDraftMessage(draftId: string, message: string): DraftRecord {
    const record = this.getDraft(draftId);
    if (record.state === 'running') {
      throw new OrchestratorConflictError(
        `draft is busy: a turn is already in progress: ${draftId}`
      );
    }
    const planner = this.planners.get(record.plannerName);
    if (planner === undefined) {
      throw new OrchestratorClientError(
        `unknown planner: ${record.plannerName}`
      );
    }
    this.updateDraftRecord(draftId, {
      state: 'running',
      error: null,
      questions: [],
    });
    const sessionId = record.sessionId;
    const model = loadConfig(this.ctx.rootDir).models.draft;
    void this.runDraftTurn(draftId, () =>
      planner.sendMessage(sessionId, message, model, 'draft')
    );
    return this.getDraft(draftId);
  }

  // Runs one draft turn to completion; a turn with neither a proposal nor
  // questions is a failure (the planner produced nothing to act on).
  private async runDraftTurn(
    draftId: string,
    run: () => Promise<PlannerTurn>
  ): Promise<void> {
    try {
      const turn = await run();
      const proposal = validatePlanProposalOrNull(turn.proposal);
      const current = this.drafts.get(draftId);
      if (current === undefined) return;
      if (
        (proposal === null || proposal.tasks.length === 0) &&
        turn.questions.length === 0
      ) {
        throw new OrchestratorClientError(
          'planner produced no task for this description'
        );
      }
      this.updateDraftRecord(draftId, {
        state: 'ready',
        message: turn.reply,
        ...(proposal !== null ? { proposal } : {}),
        questions: turn.questions,
        sessionId: turn.sessionId ?? current.sessionId,
      });
    } catch (err) {
      this.updateDraftRecord(draftId, {
        state: 'failed',
        error: (err as Error).message,
      });
    }
  }

  private updateDraftRecord(
    draftId: string,
    patch: Partial<DraftRecord>
  ): void {
    const record = this.drafts.get(draftId);
    if (record === undefined) return;
    const updated: DraftRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(draftId, updated);
    this.ctx.events.broadcast({ type: 'draft.changed' });
  }

  getDraft(draftId: string): DraftRecord {
    const record = this.drafts.get(draftId);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(`draft not found: ${draftId}`);
    }
    return record;
  }

  // Newest first, matching how the client wants to render "your recent
  // drafts" — most useful one on top.
  listDrafts(): DraftRecord[] {
    return [...this.drafts.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  // Removes a reviewed draft; a silent no-op for an unknown id (api.ts's
  // DELETE handler 404s that case itself before calling this).
  dismissDraft(draftId: string): void {
    if (this.drafts.delete(draftId)) {
      this.ctx.events.broadcast({ type: 'draft.changed' });
    }
  }

  // Drops the oldest non-running drafts once over MAX_DRAFTS; a running
  // draft is never evicted.
  private evictOldDrafts(): void {
    if (this.drafts.size <= MAX_DRAFTS) return;
    const evictable = [...this.drafts.values()]
      .filter((d) => d.state !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let overBy = this.drafts.size - MAX_DRAFTS;
    for (const draft of evictable) {
      if (overBy <= 0) break;
      this.drafts.delete(draft.id);
      overBy--;
    }
  }

  // Sends a follow-up user message on an existing plan and returns the record
  // immediately with the message recorded and state back to `running` — the
  // planner's reply lands fire-and-forget via runTurn(), same as startPlan.
  // The conversation must be idle (not mid-turn) and not already confirmed:
  // a plan still `running` has a turn in flight to answer first, and a
  // confirmed plan's proposal is already written and immutable.
  sendMessage(planId: string, message: string): PlanRecord {
    const record = this.get(planId);
    if (record.confirmedAt !== undefined) {
      throw new OrchestratorConflictError(`plan already confirmed: ${planId}`);
    }
    if (record.state === 'running') {
      throw new OrchestratorConflictError(
        `plan is busy: a turn is already in progress: ${planId}`
      );
    }
    const planner = this.planners.get(record.plannerName);
    if (planner === undefined) {
      throw new OrchestratorClientError(
        `unknown planner: ${record.plannerName}`
      );
    }
    const now = new Date().toISOString();
    const updated: PlanRecord = {
      ...record,
      state: 'running',
      messages: [...record.messages, { role: 'user', text: message, at: now }],
      // A new turn supersedes any prior failure — clear the stale error so a
      // retry after a failed turn doesn't keep advertising the old message.
      error: undefined,
      // Superseded by this new message — clear so a stale form doesn't linger.
      questions: [],
      updatedAt: now,
    };
    this.plans.set(planId, updated);
    this.ctx.events.broadcast({ type: 'plan.changed', planId });
    const sessionId = record.sessionId;
    const model = this.resolveModel(record.role);
    void this.runTurn(planId, () =>
      planner.sendMessage(sessionId, message, model, 'plan')
    );
    return updated;
  }

  // Runs one planner turn and folds it into the record; a `null` turn
  // proposal (questions-only) leaves the prior working proposal untouched.
  private async runTurn(
    planId: string,
    run: () => Promise<PlannerTurn>
  ): Promise<void> {
    try {
      const turn = await run();
      // A Planner (Fake or Claude) can itself return a proposal that fails
      // validation — re-validate here (the same validatePlanProposal confirm()
      // uses) so a plan never sits at `ready` advertising a proposal nobody
      // could actually confirm; an invalid one downgrades to `failed` with the
      // validation message instead.
      const proposal = validatePlanProposalOrNull(turn.proposal);
      const current = this.plans.get(planId);
      if (current === undefined) return;
      // Unlike runDraftTurn, an empty turn isn't rejected here — the plan
      // conversation always has PlansView's free-text composer as an escape hatch.
      this.updateRecord(planId, {
        state: 'ready',
        ...(proposal !== null ? { proposal } : {}),
        questions: turn.questions,
        sessionId: turn.sessionId ?? current.sessionId,
        messages: [
          ...current.messages,
          { role: 'assistant', text: turn.reply, at: new Date().toISOString() },
        ],
      });
    } catch (err) {
      this.updateRecord(planId, {
        state: 'failed',
        error: (err as Error).message,
      });
    }
  }

  private updateRecord(planId: string, patch: Partial<PlanRecord>): void {
    const record = this.plans.get(planId);
    if (record === undefined) return;
    const updated: PlanRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.plans.set(planId, updated);
    this.ctx.events.broadcast({ type: 'plan.changed', planId });
  }

  get(planId: string): PlanRecord {
    const record = this.plans.get(planId);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(`plan not found: ${planId}`);
    }
    return record;
  }

  // POST /api/plan/:id/confirm. `rawProposal` is whatever JSON the client
  // sent — always re-validated from scratch here (never trusted, and never
  // read off the stored record's own `proposal`) since the plan explicitly
  // allows the client to edit a proposal before confirming it: "the confirm
  // body is authoritative, re-validated."
  confirm(planId: string, rawProposal: unknown): ConfirmResult {
    const record = this.get(planId);
    if (record.confirmedAt !== undefined) {
      throw new OrchestratorConflictError(`plan already confirmed: ${planId}`);
    }
    // Minor fix: confirm is only meaningful once the planner has actually
    // produced a (validated-at-ready-time) proposal — a plan still
    // `running` or one that ended `failed` has nothing legitimate to
    // confirm against, even though the confirm body itself is otherwise
    // re-validated from scratch below.
    if (record.state !== 'ready') {
      throw new OrchestratorConflictError(
        `plan is not ready to confirm: ${planId} (state: ${record.state})`
      );
    }
    const proposal = validatePlanProposal(rawProposal);

    let epicId: string | undefined;
    if (proposal.epic !== undefined) {
      const epicDoc = this.ctx.store.create({
        title: proposal.epic.title,
        kind: 'epic',
        status: 'todo',
        description: proposal.epic.description,
      });
      epicId = epicDoc.meta.id;
    }

    // Pass 1: create every task with no blockedBy yet — blockedByIndices
    // can point at a *later* sibling in the proposal, so every task's real
    // id must exist before any blockedBy gets wired up in pass 2.
    const taskIds = proposal.tasks.map(
      (task) =>
        this.ctx.store.create({
          title: task.title,
          kind: 'task',
          status: 'todo',
          description: buildTaskDescription(task),
          parent: epicId ?? null,
          priority: task.priority,
          writes: task.writes,
          risk: task.risk,
        }).meta.id
    );

    // Pass 2: map each task's blockedByIndices (positions within this same
    // proposal) to the real ids pass 1 just minted, and write that as a
    // single blockedBy patch — skipped entirely for a task with no
    // dependencies so it isn't rewritten for no reason.
    const now = new Date().toISOString();
    proposal.tasks.forEach((task, i) => {
      if (task.blockedByIndices.length === 0) return;
      const blockedBy = task.blockedByIndices.map((idx) => taskIds[idx]);
      this.ctx.store.update(taskIds[i], { blockedBy }, now);
    });

    // Undeclared `writes` conflicts with everything (safe default), which
    // silently serializes an epic dispatch — leave a visible trail for why.
    if (
      epicId !== undefined &&
      proposal.tasks.some(
        (t) => t.writes === undefined || t.writes.length === 0
      )
    ) {
      this.ctx.store.update(
        epicId,
        {
          appendActivity: `${now} [plan] confirmed with undeclared writes on at least one task — those tasks fully serialize during epic dispatch`,
          // confirm() is only ever reached through the human-facing plan
          // confirmation endpoint — no agent tool confirms a plan.
          activityActor: this.ctx.actorContext?.humanRef,
        },
        now
      );
    }

    this.updateRecord(planId, { confirmedAt: now });
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    return { epicId, taskIds };
  }
}
