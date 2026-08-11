import { loadConfig } from '@dispatch/core';
import { createHash, randomBytes } from 'node:crypto';

import type { EventBus } from '../events.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';
import type {
  WardenBackend,
  WardenToolDescriptor,
  WardenToolResult,
  WardenToolset,
  WardenTurn,
} from './wardenBackend.js';
import type { WardenAction, WardenToolRegistry } from './wardenTools.js';

// Same short collision-resistant hex tag as plan.ts's generatePlanId, and
// local to this package for the same reason: a warden conversation is a purely
// server-side, in-memory concept that is never written to a task file.
function generateWardenId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `wc-${hash}`;
}

// `running` means a turn is in flight; `ready` means the last turn settled and
// the conversation is idle (possibly with actions awaiting confirmation);
// `failed` means the last turn errored. Mirrors PlanState.
type WardenState = 'running' | 'ready' | 'failed';

/**
 * One transcript entry.
 *
 * `user`/`assistant` are the conversation proper. `tool` records a read-only
 * tool call the assistant made mid-turn, so the human can see what the answer
 * was actually derived from. `action` records a mutating tool call's life:
 * queued at `pending`, then `applied`/`denied`/`failed` once a human decides.
 */
export interface WardenMessage {
  role: 'user' | 'assistant' | 'tool' | 'action';
  text: string;
  at: string;
  /** `tool` and `action` entries: which warden tool the entry is about. */
  tool?: string;
  /** `action` entries: the WardenAction this entry reports on. */
  actionId?: string;
  /**
   * `action` entries only. `failed` means the human approved but the effect
   * itself threw — the action stays pending so it can be retried.
   */
  outcome?: 'pending' | 'applied' | 'denied' | 'failed';
}

export interface WardenRecord {
  id: string;
  /** The opening prompt, kept alongside `messages[0]` for callers that only want the ask. */
  prompt: string;
  /** Which registered backend this conversation talks to; follow-ups re-resolve it. */
  backendName: string;
  state: WardenState;
  messages: WardenMessage[];
  /**
   * Mutating tool calls this conversation has queued that nobody has decided
   * on yet — the confirmation queue the chat UI renders. Snapshots taken when
   * the call was made; the registry stays the source of truth for whether an
   * action has since been applied.
   */
  pendingActions: WardenAction[];
  /**
   * Decisions the human has made since the last turn, not yet shown to the
   * model. Drained into the next `sendMessage`'s prompt so the assistant never
   * claims it cancelled a run the human refused (or keeps offering to do
   * something that already happened) — the model's own tool result only ever
   * said "queued", so this is the only way the outcome reaches it.
   */
  undeliveredDecisions: string[];
  /** The backend's resume handle from the most recent turn. */
  sessionId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WardenManagerContext {
  rootDir: string;
  registry: WardenToolRegistry;
  events: EventBus;
}

// What a mutating tool call returns to the model. Deliberately explicit that
// nothing happened: a model told only "ok" would go on to report the run as
// cancelled in the very same turn.
const QUEUED_NOTE =
  'Queued for human confirmation. NOTHING has happened yet and nothing will ' +
  'until the human confirms it in the chat UI. Do not say the action was ' +
  'taken — tell the user what you have queued and that it needs their ' +
  'confirmation.';

// How much of a status tool's result is kept in the transcript. The model gets
// the whole payload; this copy exists so the human can see what a claim was
// based on, and a full merge-queue or ledger dump would swamp the chat.
const MAX_TOOL_TEXT = 2000;

// Renders a tool result for the transcript: compact JSON, capped.
function describeToolResult(data: unknown): string {
  const text = JSON.stringify(data) ?? String(data);
  return text.length <= MAX_TOOL_TEXT
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT)}… (truncated)`;
}

/**
 * Owns the warden's chat conversations (epic: the project assistant tab):
 * drives a `WardenBackend` as a multi-turn, tool-calling conversation and
 * tracks each turn's running -> ready|failed state plus the transcript in a
 * small in-memory registry. Machine-local, exactly like PlanManager — a
 * conversation that was still `running` when dispatchd restarts is simply gone.
 *
 * The rule this class exists to enforce, on top of what WardenToolRegistry
 * already guarantees: a turn's mutating tool calls are *collected*, never
 * executed. They land on the record as `pendingActions`, and
 * `confirmAction(id, actionId, true)` is the only path in this class that
 * reaches `applyAction`. `confirmAction(..., false)` never calls it at all.
 *
 * Backends are registered by name (mirrors PlanManager's own
 * `registerPlanner`/`registeredPlannerNames` pair), so a caller can pick
 * `claude` or `fake` per conversation the same way `POST /api/plan` picks a
 * planner.
 */
export class WardenManager {
  private readonly conversations = new Map<string, WardenRecord>();
  private readonly backends = new Map<string, WardenBackend>();

  constructor(private readonly ctx: WardenManagerContext) {}

  registerBackend(name: string, backend: WardenBackend): void {
    this.backends.set(name, backend);
  }

  registeredBackendNames(): string[] {
    return [...this.backends.keys()];
  }

  // Fresh per-call read of `config.models`, so a settings change takes effect
  // on the very next turn with no daemon restart. The warden runs on the
  // `plan` role's model: it is the same kind of work (a multi-turn
  // conversation that reasons over project state) and adding a dedicated role
  // would mean a core config + Settings-screen change this seam doesn't need
  // — swapping the role later is a one-line change here.
  private resolveModel(): string {
    return loadConfig(this.ctx.rootDir).models.plan;
  }

  private requireBackend(name: string): WardenBackend {
    const backend = this.backends.get(name);
    if (backend === undefined) {
      throw new OrchestratorClientError(`unknown warden backend: ${name}`);
    }
    return backend;
  }

  /**
   * Opens a conversation and returns its record immediately at `running`; the
   * backend turn is fire-and-forget, landing via runTurn's broadcast — same
   * contract as PlanManager.startPlan.
   */
  start(prompt: string, backendName = 'claude'): WardenRecord {
    const backend = this.requireBackend(backendName);
    const now = new Date().toISOString();
    const record: WardenRecord = {
      id: generateWardenId(now),
      prompt,
      backendName,
      state: 'running',
      messages: [{ role: 'user', text: prompt, at: now }],
      pendingActions: [],
      undeliveredDecisions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(record.id, record);
    const model = this.resolveModel();
    const toolset = this.toolsetFor(record.id);
    void this.runTurn(record.id, () => backend.start(prompt, toolset, model));
    return record;
  }

  /**
   * Sends a follow-up on an existing conversation. The record comes back
   * immediately with the message recorded and state back to `running`; the
   * reply lands fire-and-forget. The conversation must be idle — a `running`
   * one has a turn in flight to finish first.
   */
  sendMessage(conversationId: string, message: string): WardenRecord {
    const record = this.get(conversationId);
    if (record.state === 'running') {
      throw new OrchestratorConflictError(
        `warden conversation is busy: a turn is already in progress: ${conversationId}`
      );
    }
    const backend = this.requireBackend(record.backendName);
    const now = new Date().toISOString();
    const updated: WardenRecord = {
      ...record,
      state: 'running',
      messages: [...record.messages, { role: 'user', text: message, at: now }],
      // Handed to the backend below, so they must not be delivered twice.
      undeliveredDecisions: [],
      // A new turn supersedes any prior failure.
      error: undefined,
      updatedAt: now,
    };
    this.conversations.set(conversationId, updated);
    this.ctx.events.broadcast({ type: 'warden.changed', conversationId });

    // The transcript keeps what the human actually typed; the model gets that
    // plus the decisions it hasn't been told about yet.
    const outgoing = withDecisions(message, record.undeliveredDecisions);
    const sessionId = record.sessionId;
    const model = this.resolveModel();
    const toolset = this.toolsetFor(conversationId);
    void this.runTurn(
      conversationId,
      () => backend.sendMessage(sessionId, outgoing, toolset, model),
      record.undeliveredDecisions
    );
    return updated;
  }

  // Runs one backend turn and folds its reply into the transcript. Tool calls
  // have already appended themselves by the time this resolves. `drained` is
  // whatever decisions this turn's prompt carried: a turn that failed may never
  // have reached the model at all, so they go back on the record rather than
  // being silently lost — the point of those notices is that the assistant
  // never contradicts what the human actually decided.
  private async runTurn(
    conversationId: string,
    run: () => Promise<WardenTurn>,
    drained: string[] = []
  ): Promise<void> {
    try {
      const turn = await run();
      const current = this.conversations.get(conversationId);
      if (current === undefined) return;
      this.updateRecord(conversationId, {
        state: 'ready',
        sessionId: turn.sessionId ?? current.sessionId,
        messages: [
          ...current.messages,
          { role: 'assistant', text: turn.reply, at: new Date().toISOString() },
        ],
      });
    } catch (err) {
      const current = this.conversations.get(conversationId);
      this.updateRecord(conversationId, {
        state: 'failed',
        error: (err as Error).message,
        // Oldest first: anything decided *during* the failed turn comes after.
        undeliveredDecisions: [
          ...drained,
          ...(current?.undeliveredDecisions ?? []),
        ],
      });
    }
  }

  get(conversationId: string): WardenRecord {
    const record = this.conversations.get(conversationId);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(
        `warden conversation not found: ${conversationId}`
      );
    }
    return record;
  }

  /** Newest first, matching how a chat list wants to render them. */
  list(): WardenRecord[] {
    return [...this.conversations.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  /**
   * Decides one queued action.
   *
   * `approve: true` calls the registry's `applyAction` — the only call to it
   * in this class — and folds its real outcome into the transcript: `applied`
   * when the effect ran, `failed` (with the thrown message, and the action
   * left pending to retry) when it didn't. `approve: false` never calls it and
   * records a denial.
   *
   * Deliberately allowed while a turn is `running`: the action was queued by
   * an earlier turn, and making a human wait for the assistant to stop talking
   * before they can approve a cancel would be exactly backwards.
   */
  async confirmAction(
    conversationId: string,
    actionId: string,
    approve: boolean
  ): Promise<WardenRecord> {
    const record = this.get(conversationId);
    // Membership check, not just "is this action pending anywhere": one
    // registry is shared by every conversation, so without this, conversation
    // A could confirm an action queued in conversation B.
    const action = record.pendingActions.find((a) => a.id === actionId);
    if (action === undefined) {
      throw new OrchestratorNotFoundError(
        `no action awaiting confirmation on ${conversationId}: ${actionId}`
      );
    }

    if (!approve) {
      const denied = this.ctx.registry.denyAction(actionId);
      this.settleAction(conversationId, denied, 'denied');
      return this.get(conversationId);
    }

    // Claimed before the await, mirroring the registry's own claim-first
    // guard: two confirmations racing each other must not both reach apply.
    this.dropPendingAction(conversationId, actionId);
    try {
      const applied = await this.ctx.registry.applyAction(actionId);
      this.settleAction(conversationId, applied, 'applied');
    } catch (err) {
      const message = (err as Error).message;
      // The registry restores a failed action to `pending`, so restore it here
      // too — the human approved it and may well want to retry.
      this.restorePendingAction(conversationId, action);
      this.appendMessage(conversationId, {
        role: 'action',
        tool: action.tool,
        actionId,
        outcome: 'failed',
        text: `Failed: ${action.summary} — ${message}`,
      });
      this.noteDecision(
        conversationId,
        `${action.summary} — the human approved it, but it failed: ${message}`
      );
      throw err;
    }
    return this.get(conversationId);
  }

  // ---------------------------------------------------------------------
  // Tool plumbing
  // ---------------------------------------------------------------------

  // The toolset one turn of `conversationId` gets. Bound to the conversation
  // so every call lands on the right transcript, and built per turn rather
  // than once per conversation so a tool added to the registry shows up on the
  // next turn rather than only for new conversations.
  private toolsetFor(conversationId: string): WardenToolset {
    const { registry } = this.ctx;
    const tools: WardenToolDescriptor[] = [
      ...registry.statusTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        mutating: false,
      })),
      ...registry.mutatingTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        mutating: true,
      })),
    ];
    return {
      tools,
      call: (name, input) =>
        Promise.resolve(this.callTool(conversationId, name, input)),
    };
  }

  // Routes one tool call: a status tool runs now, a mutating tool only queues.
  // Never throws — a tool-level failure comes back as `isError` so the model
  // can fix its call, exactly like the registry's own WardenToolError contract.
  private callTool(
    conversationId: string,
    name: string,
    input: unknown
  ): WardenToolResult {
    const { registry } = this.ctx;
    const mutating = registry.mutatingTools().some((t) => t.name === name);
    const known =
      mutating || registry.statusTools().some((t) => t.name === name);
    try {
      if (!known) throw new Error(`unknown warden tool: ${name}`);
      if (mutating) {
        const action = registry.callMutatingTool(name, input);
        this.queueAction(conversationId, action);
        return {
          content: {
            queued: true,
            actionId: action.id,
            summary: action.summary,
            note: QUEUED_NOTE,
          },
          isError: false,
          action,
        };
      }
      const data = registry.callStatusTool(name, input);
      this.appendMessage(conversationId, {
        role: 'tool',
        tool: name,
        text: describeToolResult(data),
      });
      return { content: data, isError: false };
    } catch (err) {
      const message = (err as Error).message;
      this.appendMessage(conversationId, {
        role: 'tool',
        tool: name,
        text: `error: ${message}`,
      });
      return { content: { error: message }, isError: true };
    }
  }

  // ---------------------------------------------------------------------
  // Record bookkeeping
  // ---------------------------------------------------------------------

  // Records a queued action on both the confirmation list and the transcript.
  private queueAction(conversationId: string, action: WardenAction): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    this.updateRecord(conversationId, {
      pendingActions: [...record.pendingActions, { ...action }],
    });
    this.appendMessage(conversationId, {
      role: 'action',
      tool: action.tool,
      actionId: action.id,
      outcome: 'pending',
      text: action.summary,
    });
  }

  // Drops a decided action off the confirmation list, appends the transcript
  // entry recording what happened to it, and queues the same news for the
  // model's next turn.
  private settleAction(
    conversationId: string,
    action: WardenAction,
    outcome: 'applied' | 'denied'
  ): void {
    this.dropPendingAction(conversationId, action.id);
    const verb = outcome === 'applied' ? 'Applied' : 'Denied';
    this.appendMessage(conversationId, {
      role: 'action',
      tool: action.tool,
      actionId: action.id,
      outcome,
      text: `${verb}: ${action.summary}`,
    });
    this.noteDecision(
      conversationId,
      outcome === 'applied'
        ? `${action.summary} — the human approved this, and it has now been done.`
        : `${action.summary} — the human REFUSED this. It did not happen.`
    );
  }

  private dropPendingAction(conversationId: string, actionId: string): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    this.updateRecord(conversationId, {
      pendingActions: record.pendingActions.filter((a) => a.id !== actionId),
    });
  }

  private restorePendingAction(
    conversationId: string,
    action: WardenAction
  ): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    if (record.pendingActions.some((a) => a.id === action.id)) return;
    this.updateRecord(conversationId, {
      pendingActions: [...record.pendingActions, { ...action }],
    });
  }

  private noteDecision(conversationId: string, note: string): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    this.updateRecord(conversationId, {
      undeliveredDecisions: [...record.undeliveredDecisions, note],
    });
  }

  // Appends one transcript entry, stamped now.
  private appendMessage(
    conversationId: string,
    message: Omit<WardenMessage, 'at'>
  ): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    this.updateRecord(conversationId, {
      messages: [
        ...record.messages,
        { ...message, at: new Date().toISOString() },
      ],
    });
  }

  private updateRecord(
    conversationId: string,
    patch: Partial<WardenRecord>
  ): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    const updated: WardenRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.conversations.set(conversationId, updated);
    this.ctx.events.broadcast({ type: 'warden.changed', conversationId });
  }
}

// Prefixes a follow-up with whatever the human decided since the last turn.
// Plain text rather than a tool result because there is no open tool call to
// answer: the turn that queued the action ended long before the human clicked.
function withDecisions(message: string, decisions: string[]): string {
  if (decisions.length === 0) return message;
  return [
    'Since your last turn the human decided on the actions you queued:',
    ...decisions.map((d) => `- ${d}`),
    '',
    message,
  ].join('\n');
}
