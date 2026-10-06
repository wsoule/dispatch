import { loadConfig, untrustedInline } from '@dispatch-foo/core';
import type { EffortLevel } from '@dispatch-foo/core';
import type { Message, Sender } from '@dispatch-foo/protocol';
import { SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import { createHash, randomBytes } from 'node:crypto';

import type { EventBus } from '../events.js';
import { floorCheckForToolInput } from '../floor.js';
import type { OverseerBus } from '../messaging/overseerBus.js';
import type {
  OverseerBackend,
  OverseerToolDescriptor,
  OverseerToolRequest,
  OverseerToolResult,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from './overseerBackend.js';
import { grantKey, GrantStore, type GrantView } from './overseerGrants.js';
import type { OverseerStore } from './overseerStore.js';
import type { OverseerAction, OverseerToolRegistry } from './overseerTools.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';
import type { ApprovalDecision } from './types.js';

// Same short collision-resistant hex tag as plan.ts's generatePlanId, and
// local to this package for the same reason: a overseer conversation is a purely
// server-side, in-memory concept that is never written to a task file.
function generateOverseerId(
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
type OverseerState = 'running' | 'ready' | 'failed';

/**
 * One transcript entry.
 *
 * `user`/`assistant` are the conversation proper. `tool` records a tool call
 * the assistant made mid-turn — a registry status tool or a built-in one — so
 * the human can see what the answer was actually derived from. `action`
 * records a mutating registry call's life: queued at `pending`, then
 * `applied`/`denied`/`failed` once a human decides. `approval` records a
 * built-in tool call's life: parked at `pending`, then `allowed`/`denied`.
 */
export interface OverseerMessage {
  role: 'user' | 'assistant' | 'tool' | 'action' | 'approval' | 'notice';
  text: string;
  at: string;
  /** `tool`, `action` and `approval` entries: which tool the entry is about. */
  tool?: string;
  /** `action` entries: the OverseerAction this entry reports on. */
  actionId?: string;
  /** `approval` entries: the OverseerApproval this entry reports on. */
  requestId?: string;
  /**
   * `action` and `approval` entries only. `failed` means the human approved
   * an action but the effect itself threw — the action stays pending so it
   * can be retried. `allowed` is an approval's yes; `applied` an action's.
   */
  outcome?: 'pending' | 'applied' | 'allowed' | 'denied' | 'failed';
  /** `user` and `assistant` entries posted to the bus: the message there. */
  messageId?: string;
  /** `assistant` entries: what the turn that produced it cost. */
  costUsd?: number;
  /** `notice` entries: a line across the stream, not a speaker's words. */
  notice?: 'stopped' | 'rollover' | 'restarted';
}

/**
 * A built-in tool call parked on the human: the session wants to run Bash,
 * Edit, or some other non-registry tool that the project's permission policy
 * did not settle by itself, and the model's turn is blocked until someone
 * decides. Unlike an OverseerAction, deciding one is time-critical — the
 * conversation cannot continue past it — and allowing it runs the call at
 * once rather than queueing anything.
 */
interface OverseerApproval {
  /** The backend's handle for the call; what its gate's `requestId` names. */
  requestId: string;
  toolName: string;
  /** The call's input, exactly as the tool will receive it if allowed. */
  input: unknown;
  /** One line, safe to render verbatim, saying what the call would do. */
  summary: string;
  requestedAt: string;
  /** Held by the floor or an Overseer hold: never covered by, or a source of, a session grant. */
  held?: boolean;
}

export interface OverseerRecord {
  id: string;
  /** The human who opened it; only they and the operator read it or speak in it. */
  owner?: string;
  /** The opening prompt, kept alongside `messages[0]` for callers that only want the ask. */
  prompt: string;
  /** Which registered backend this conversation talks to; follow-ups re-resolve it. */
  backendName: string;
  /**
   * The model this conversation was opened on, when the caller chose one.
   * Every follow-up reuses it so a conversation is one model throughout;
   * absent, each turn reads the `overseer` role's configured model afresh.
   */
  model?: string;
  /** The effort this conversation was opened on, when the caller chose one;
   *  same rule as `model`, falling back to config `effort.overseer`. */
  effort?: EffortLevel;
  state: OverseerState;
  messages: OverseerMessage[];
  /**
   * Mutating tool calls this conversation has queued that nobody has decided
   * on yet — the confirmation queue the chat UI renders. Snapshots taken when
   * the call was made; the registry stays the source of truth for whether an
   * action has since been applied.
   */
  pendingActions: OverseerAction[];
  /**
   * Built-in tool calls the running turn is blocked on, oldest first. Only
   * ever non-empty while `state` is `running`: a turn that ends, however it
   * ends, denies whatever was still parked.
   */
  pendingApprovals: OverseerApproval[];
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
  /** How full the session's context was at the end of the last turn, in tokens. */
  contextTokens?: number;
  /** What every turn of this conversation has cost so far. */
  spendUsd?: number;
  /** Messages typed while a turn ran; they go out together when it ends. */
  queued?: { text: string; at: string }[];
  /** The bus thread this conversation's lines are posted to, once one is. */
  thread?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OverseerManagerContext {
  rootDir: string;
  registry: OverseerToolRegistry;
  events: EventBus;
  /** Where conversation lines are posted and decisions raised as gates. */
  bus?: OverseerBus;
  /** Where conversations outlive the daemon; in memory only when absent. */
  store?: OverseerStore;
}

// What a mutating tool call returns to the model. Deliberately explicit that
// nothing happened: a model told only "ok" would go on to report the run as
// cancelled in the very same turn.
const QUEUED_NOTE =
  'Queued for human confirmation. NOTHING has happened yet and nothing will ' +
  'until the human confirms its approval card. Do not say the action was ' +
  'taken — tell the user what you have queued and that it needs their ' +
  'confirmation.';

// How much of a status tool's result is kept in the transcript. The model gets
// the whole payload; this copy exists so the human can see what a claim was
// based on, and a full merge-queue or ledger dump would swamp the chat.
const MAX_TOOL_TEXT = 2000;

// How much of a built-in tool call's input the transcript and an approval
// card quote — a whole file written by `Write` is not what a human reads
// before clicking Allow.
const MAX_CALL_TEXT = 400;

// The built-in tools `acceptEdits` auto-allows, the same set ClaudeExecutor
// applies: the mode's whole meaning is "edit files without asking, ask before
// anything else".
const AUTO_ALLOWED_EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

// What a parked built-in call is refused with when its turn ends before a
// human decided — the backend threw, or the conversation is gone.
const TURN_ENDED_DENIAL = 'the turn ended before this call was decided';

/** Past this many tokens of context, the next turn starts a fresh session from a recap. */
export const ROLLOVER_TOKENS = 150_000;

// How many recent lines a rollover recap carries, and how much of each.
const RECAP_LINES = 12;
const RECAP_LINE_CHARS = 600;

// What the model starts a rolled-over session with: the recent conversation, as data.
function recapOf(messages: OverseerMessage[]): string {
  const lines = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECAP_LINES)
    .map((m) => {
      const text =
        m.text.length <= RECAP_LINE_CHARS
          ? m.text
          : `${m.text.slice(0, RECAP_LINE_CHARS)}…`;
      return `${m.role === 'user' ? 'Human' : 'You'}: ${text}`;
    });
  return [
    'This conversation continues from an earlier session whose context filled up. Its most recent lines:',
    ...lines,
    '',
    'The human now says:',
  ].join('\n');
}

// One line saying what a built-in tool call would do, for the transcript and
// the approval card. Input is model-authored and rendered straight into the
// chat UI, so it gets the same line-break flattening every other untrusted
// string does, and a cap so a whole file body is not the card.
function describeToolCall(toolName: string, input: unknown): string {
  const fields =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const str = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === 'string' ? value : undefined;
  };
  const detail =
    str('command') ??
    str('file_path') ??
    str('pattern') ??
    str('url') ??
    str('query') ??
    (Object.keys(fields).length > 0 ? JSON.stringify(fields) : undefined);
  if (detail === undefined) return toolName;
  const flat = untrustedInline(detail);
  const capped =
    flat.length <= MAX_CALL_TEXT ? flat : `${flat.slice(0, MAX_CALL_TEXT)}…`;
  return `${toolName}: ${capped}`;
}

// Renders a tool result for the transcript: compact JSON, capped.
function describeToolResult(data: unknown): string {
  const text = JSON.stringify(data) ?? String(data);
  return text.length <= MAX_TOOL_TEXT
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT)}… (truncated)`;
}

/**
 * Owns the overseer's chat conversations (epic: the project assistant tab):
 * drives a `OverseerBackend` as a multi-turn, tool-calling conversation and
 * tracks each turn's running -> ready|failed state plus the transcript in a
 * small in-memory registry. Machine-local, exactly like PlanManager — a
 * conversation that was still `running` when dispatchd restarts is simply gone.
 *
 * Two rules this class exists to enforce, on top of what OverseerToolRegistry
 * already guarantees. A turn's mutating registry calls are *collected*, never
 * executed: they land on the record as `pendingActions`, and
 * `confirmAction(id, actionId, true)` is the only path in this class that
 * reaches `applyAction` (`confirmAction(..., false)` never calls it at all).
 * And a built-in tool call — the session is a full Claude Code session in the
 * checkout — runs only when the project's permission policy allows it
 * outright or a human does through `decideApproval`; until then it sits on
 * the record as a `pendingApprovals` entry with the model's turn blocked
 * behind it.
 *
 * Backends are registered by name (mirrors PlanManager's own
 * `registerPlanner`/`registeredPlannerNames` pair), so a caller can pick
 * `claude` or `fake` per conversation the same way `POST /api/plan` picks a
 * planner.
 */
export class OverseerManager {
  private readonly conversations = new Map<string, OverseerRecord>();
  private readonly backends = new Map<string, OverseerBackend>();
  // The resolver for each parked built-in call, keyed by requestId — what
  // `decideApproval` settles and what a turn's end sweeps.
  private readonly approvalResolvers = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();
  // What the human allowed "for this conversation": per program for Bash, up to
  // four hours or the next rollover. Off the record: a grant, not transcript.
  private readonly grants = new GrantStore();
  // Each conversation's bus posts, chained so its lines land in order.
  private readonly posts = new Map<string, Promise<void>>();
  // Conversations already logged as having a turn no human spoke.
  private readonly loggedOffBus = new Set<string>();

  // The running turn's abort handle, per conversation; Stop fires it.
  private readonly turns = new Map<string, AbortController>();
  // Who typed each conversation's queued messages, for posting them when they go.
  private readonly queuedBy = new Map<string, Sender | null>();

  constructor(private readonly ctx: OverseerManagerContext) {
    for (const loaded of ctx.store?.load() ?? []) {
      this.conversations.set(loaded.id, loaded);
      if (loaded.state === 'running') this.interrupted(loaded);
    }
  }

  // A turn the daemon died in: nothing can answer its parked calls now.
  private interrupted(record: OverseerRecord): void {
    for (const approval of record.pendingApprovals) {
      this.ctx.bus?.closeGate(
        record.id,
        { requestId: approval.requestId },
        TURN_ENDED_DENIAL
      );
    }
    this.updateRecord(record.id, {
      state: 'failed',
      error: 'Dispatch restarted during this turn',
      pendingApprovals: [],
      messages: [
        ...record.messages,
        {
          role: 'notice',
          notice: 'restarted',
          text: 'Dispatch restarted during this turn',
          at: new Date().toISOString(),
        },
      ],
    });
  }

  // Writes the record through to the store; a failed write never fails the turn.
  private persist(record: OverseerRecord): void {
    try {
      this.ctx.store?.save(record);
    } catch (err) {
      console.error(`overseer: could not save ${record.id}`, err);
    }
  }

  registerBackend(name: string, backend: OverseerBackend): void {
    this.backends.set(name, backend);
  }

  registeredBackendNames(): string[] {
    return [...this.backends.keys()];
  }

  // The knobs one turn of `conversationId` runs with. A fresh per-call read
  // of config, so a settings change takes effect on the very next turn with
  // no daemon restart: the `overseer` role's model (unless the conversation
  // was opened on a chosen one), and the same permission mode and caps a
  // dispatched run gets — the overseer is exactly as autonomous as the agents
  // it oversees. The two callbacks bind this conversation, so a parked call
  // lands on the right record.
  private turnOptionsFor(conversationId: string): OverseerTurnOptions {
    const config = loadConfig(this.ctx.rootDir);
    const record = this.conversations.get(conversationId);
    return {
      model: record?.model ?? config.models.overseer,
      effort: record?.effort ?? config.effort?.overseer,
      permissionMode: config.orchestrator.permissionMode,
      ...(config.orchestrator.maxTurns !== undefined
        ? { maxTurns: config.orchestrator.maxTurns }
        : {}),
      ...(config.orchestrator.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: config.orchestrator.maxBudgetUsd }
        : {}),
      authorizeTool: (request) =>
        this.authorizeTool(
          conversationId,
          config.orchestrator.permissionMode,
          request
        ),
      onToolUse: (toolName, input) =>
        this.appendMessage(conversationId, {
          role: 'tool',
          tool: toolName,
          text: describeToolCall(toolName, input),
        }),
    };
  }

  private requireBackend(name: string): OverseerBackend {
    const backend = this.backends.get(name);
    if (backend === undefined) {
      throw new OrchestratorClientError(`unknown overseer backend: ${name}`);
    }
    return backend;
  }

  // A revoked overseer takes no new turns until a human approves it again.
  private refuseIfRevoked(): void {
    const bus = this.ctx.bus;
    if (bus?.revoked() === true) {
      throw new OrchestratorConflictError(
        'the overseer is revoked',
        'overseer_revoked',
        `approve ${bus.overseer} in Settings → Connected agents to use it again`
      );
    }
  }

  /**
   * Opens a conversation and returns its record immediately at `running`; the
   * backend turn is fire-and-forget, landing via runTurn's broadcast — same
   * contract as PlanManager.startPlan. A human `speaker`'s turn is posted to
   * the bus; a null one (the shared agent token) is not.
   */
  start(
    prompt: string,
    backendName = 'claude',
    model?: string,
    effort?: EffortLevel,
    speaker: Sender | null = null
  ): OverseerRecord {
    const backend = this.requireBackend(backendName);
    this.refuseIfRevoked();
    const now = new Date().toISOString();
    const record: OverseerRecord = {
      id: generateOverseerId(now),
      ...(speaker !== null ? { owner: speaker.address } : {}),
      prompt,
      backendName,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      state: 'running',
      messages: [{ role: 'user', text: prompt, at: now }],
      pendingActions: [],
      pendingApprovals: [],
      undeliveredDecisions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(record.id, record);
    this.persist(record);
    this.postEntry(record.id, 0, speaker);
    const options = this.turnOptionsFor(record.id);
    const toolset = this.toolsetFor(record.id);
    void this.runTurn(
      record.id,
      (abortController) =>
        backend.start(prompt, toolset, { ...options, abortController }),
      [],
      { speaker, line: 0 }
    );
    return record;
  }

  /**
   * Sends a follow-up on an existing conversation. The record comes back
   * immediately with the message recorded and state back to `running`; the
   * reply lands fire-and-forget. While a turn is still running the message is
   * queued instead, and goes out with any others when that turn ends.
   */
  sendMessage(
    conversationId: string,
    message: string,
    speaker: Sender | null = null
  ): OverseerRecord {
    const record = this.get(conversationId);
    this.refuseIfRevoked();
    if (record.state === 'running') {
      this.queuedBy.set(conversationId, speaker);
      this.updateRecord(conversationId, {
        queued: [
          ...(record.queued ?? []),
          { text: message, at: new Date().toISOString() },
        ],
      });
      return this.get(conversationId);
    }
    const queued = (record.queued ?? []).map((q) => q.text);
    return this.beginTurn(record, [...queued, message], speaker);
  }

  // Records the human's lines and starts the turn that answers them. A
  // session past ROLLOVER_TOKENS is not resumed: the turn starts fresh from a
  // recap, behind a divider, and the old session's grants end with it.
  private beginTurn(
    record: OverseerRecord,
    texts: string[],
    speaker: Sender | null
  ): OverseerRecord {
    const backend = this.requireBackend(record.backendName);
    const conversationId = record.id;
    const now = new Date().toISOString();
    const rollover = (record.contextTokens ?? 0) >= ROLLOVER_TOKENS;
    if (rollover) this.grants.clear(conversationId);
    const divider: OverseerMessage[] = rollover
      ? [
          {
            role: 'notice',
            notice: 'rollover',
            text: 'New context · the agent continues from a recap of recent lines · grants from before this point have ended',
            at: now,
          },
        ]
      : [];
    const first = record.messages.length + divider.length;
    const updated: OverseerRecord = {
      ...record,
      state: 'running',
      messages: [
        ...record.messages,
        ...divider,
        ...texts.map((text) => ({ role: 'user' as const, text, at: now })),
      ],
      queued: [],
      // Handed to the backend below, so they must not be delivered twice.
      undeliveredDecisions: [],
      // A new turn supersedes any prior failure.
      error: undefined,
      ...(rollover ? { contextTokens: 0 } : {}),
      updatedAt: now,
    };
    this.conversations.set(conversationId, updated);
    this.persist(updated);
    this.ctx.events.broadcast({ type: 'overseer.changed', conversationId });
    texts.forEach((_, i) => this.postEntry(conversationId, first + i, speaker));
    const line = first + texts.length - 1;

    // The transcript keeps what the human actually typed; the model gets that
    // plus the decisions it hasn't been told about yet.
    const said = withDecisions(texts.join('\n\n'), record.undeliveredDecisions);
    const outgoing = rollover ? `${recapOf(record.messages)}\n${said}` : said;
    const sessionId = rollover ? undefined : record.sessionId;
    const options = this.turnOptionsFor(conversationId);
    const toolset = this.toolsetFor(conversationId);
    void this.runTurn(
      conversationId,
      (abortController) =>
        backend.sendMessage(sessionId, outgoing, toolset, {
          ...options,
          abortController,
        }),
      record.undeliveredDecisions,
      { speaker, line }
    );
    return updated;
  }

  /**
   * Stops the running turn. Its parked calls are denied, the decisions it
   * carried go back on the record, and anything queued waits for the next send.
   */
  stop(conversationId: string): OverseerRecord {
    const record = this.get(conversationId);
    const turn = this.turns.get(conversationId);
    if (record.state !== 'running' || turn === undefined) return record;
    turn.abort();
    this.sweepApprovals(conversationId);
    return this.get(conversationId);
  }

  // Runs one backend turn and folds its reply into the transcript. Tool calls
  // have already appended themselves by the time this resolves. `drained` is
  // whatever decisions this turn's prompt carried: a turn that failed may never
  // have reached the model at all, so they go back on the record rather than
  // being silently lost — the point of those notices is that the assistant
  // never contradicts what the human actually decided. `from` is who spoke the
  // turn and the index of their line, which the reply answers on the bus.
  private async runTurn(
    conversationId: string,
    run: (abortController: AbortController) => Promise<OverseerTurn>,
    drained: string[],
    from: { speaker: Sender | null; line: number }
  ): Promise<void> {
    const abort = new AbortController();
    this.turns.set(conversationId, abort);
    try {
      // Stop ends the turn here even when a backend ignores the signal.
      const turn = await Promise.race([
        run(abort),
        rejectOnAbort(abort.signal),
      ]);
      if (abort.signal.aborted) throw new Error('stopped');
      const current = this.conversations.get(conversationId);
      if (current === undefined) return;
      this.updateRecord(conversationId, {
        state: 'ready',
        sessionId: turn.sessionId ?? current.sessionId,
        ...(turn.contextTokens !== undefined
          ? { contextTokens: turn.contextTokens }
          : {}),
        ...(turn.costUsd !== undefined
          ? { spendUsd: (current.spendUsd ?? 0) + turn.costUsd }
          : {}),
        messages: [
          ...current.messages,
          {
            role: 'assistant',
            text: turn.reply,
            at: new Date().toISOString(),
            ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
          },
        ],
      });
      this.postEntry(
        conversationId,
        current.messages.length,
        from.speaker,
        from.line
      );
    } catch (err) {
      const current = this.conversations.get(conversationId);
      // Oldest first: anything decided *during* the turn comes after.
      const undeliveredDecisions = [
        ...drained,
        ...(current?.undeliveredDecisions ?? []),
      ];
      if (abort.signal.aborted) {
        this.updateRecord(conversationId, {
          state: 'ready',
          undeliveredDecisions,
          messages: [
            ...(current?.messages ?? []),
            {
              role: 'notice',
              notice: 'stopped',
              text: 'Stopped',
              at: new Date().toISOString(),
            },
          ],
        });
      } else {
        this.updateRecord(conversationId, {
          state: 'failed',
          error: (err as Error).message,
          undeliveredDecisions,
        });
      }
    } finally {
      this.turns.delete(conversationId);
      // A turn that is over has no tool call left to run: anything still
      // parked would otherwise sit on the record forever, undecidable in any
      // way that could matter.
      this.sweepApprovals(conversationId);
      if (!abort.signal.aborted) this.sendQueued(conversationId);
    }
  }

  // Sends what was typed during the turn that just ended, as one turn.
  private sendQueued(conversationId: string): void {
    const record = this.conversations.get(conversationId);
    const queued = record?.queued ?? [];
    if (record === undefined || queued.length === 0) return;
    if (this.ctx.bus?.revoked() === true) return;
    const speaker = this.queuedBy.get(conversationId) ?? null;
    this.queuedBy.delete(conversationId);
    try {
      this.beginTurn(
        record,
        queued.map((q) => q.text),
        speaker
      );
    } catch (err) {
      console.error(`overseer: could not send ${conversationId}'s queue`, err);
    }
  }

  /**
   * Changes the model or effort the conversation's next turns run on; `null`
   * goes back to the project's configured default. A running turn keeps its own.
   */
  setOptions(
    conversationId: string,
    options: { model?: string | null; effort?: EffortLevel | null }
  ): OverseerRecord {
    const record = this.get(conversationId);
    const next: OverseerRecord = { ...record };
    if (options.model === null) delete next.model;
    else if (options.model !== undefined) next.model = options.model;
    if (options.effort === null) delete next.effort;
    else if (options.effort !== undefined) next.effort = options.effort;
    this.updateRecord(conversationId, {
      model: next.model,
      effort: next.effort,
    });
    return this.get(conversationId);
  }

  /** The newest conversation `owner` opened, or undefined: one per person per project. */
  current(owner: string | null): OverseerRecord | undefined {
    return this.list().find((record) =>
      owner === null ? record.owner === undefined : record.owner === owner
    );
  }

  /** The conversation, or undefined when there is none by that id. */
  find(conversationId: string): OverseerRecord | undefined {
    return this.conversations.get(conversationId);
  }

  get(conversationId: string): OverseerRecord {
    const record = this.conversations.get(conversationId);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(
        `overseer conversation not found: ${conversationId}`
      );
    }
    return record;
  }

  /** Newest first, matching how a chat list wants to render them. */
  list(): OverseerRecord[] {
    return [...this.conversations.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  /**
   * Decides one queued action, as `actor` (the daemon itself when omitted);
   * `ownerCredential` says whether they answered with the owner's app token.
   *
   * `approve: true` calls the registry's `applyAction` — the only call to it
   * in this class — and folds its real outcome into the transcript: `applied`
   * when the effect ran, `failed` (with the thrown message, the action left
   * pending to retry, and its gate raised again with the error) when it
   * didn't. `approve: false` never calls it and records a denial.
   *
   * Deliberately allowed while a turn is `running`: the action was queued by
   * an earlier turn, and making a human wait for the assistant to stop talking
   * before they can approve a cancel would be exactly backwards.
   */
  async confirmAction(
    conversationId: string,
    actionId: string,
    approve: boolean,
    actor: string = SYSTEM_ADDRESS,
    ownerCredential = false
  ): Promise<OverseerRecord> {
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
      // Only a decide-tier human (or the system) can answer the action's gate.
      const applied = await this.ctx.registry.applyAction(actionId, {
        actor,
        ownerCredential,
        canDecide: true,
      });
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
      await this.raiseActionGate(conversationId, action, message);
      throw err;
    }
    return this.get(conversationId);
  }

  /** The live grants in a conversation, for Settings to list and revoke. */
  listGrants(conversationId: string): GrantView[] {
    this.get(conversationId);
    return this.grants.list(conversationId, Date.now());
  }

  /** Ends one grant at once; false when there was none. */
  revokeGrant(conversationId: string, key: string): boolean {
    this.get(conversationId);
    return this.grants.revoke(conversationId, key);
  }

  /**
   * Decides one parked built-in tool call. Allowing it lets the call run at
   * once (the turn was blocked on exactly this); `scope: 'session'` also
   * pre-approves the same tool for the rest of this conversation. Denying
   * hands `reason` to the model as the refusal. Either way the request
   * leaves `pendingApprovals` and the transcript records what happened.
   */
  decideApproval(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision,
    // The tool the answered card showed; a different parked call is refused.
    expectedTool?: string
  ): OverseerRecord {
    const record = this.get(conversationId);
    const approval = record.pendingApprovals.find(
      (a) => a.requestId === requestId
    );
    const resolve = this.approvalResolvers.get(requestId);
    // Membership on this record AND a live resolver: a requestId from another
    // conversation, or one the turn already swept, must not be answerable.
    if (approval === undefined || resolve === undefined) {
      throw new OrchestratorNotFoundError(
        `no tool call awaiting approval on ${conversationId}: ${requestId}`
      );
    }
    if (expectedTool !== undefined && approval.toolName !== expectedTool) {
      throw new OrchestratorNotFoundError(
        `the card answered was for ${expectedTool}, but ${requestId} is waiting on ${approval.toolName}`
      );
    }
    this.approvalResolvers.delete(requestId);
    this.updateRecord(conversationId, {
      pendingApprovals: record.pendingApprovals.filter(
        (a) => a.requestId !== requestId
      ),
    });
    // A held call is allowed once, whatever was asked: no grant ever covers one.
    const granted =
      decision.allow && decision.scope === 'session' && approval.held !== true;
    if (granted) {
      this.grants.grant(
        conversationId,
        grantKey(approval.toolName, approval.input),
        Date.now(),
        record.sessionId
      );
    }
    const reason = decision.reason?.trim();
    this.appendMessage(conversationId, {
      role: 'approval',
      tool: approval.toolName,
      requestId,
      outcome: decision.allow ? 'allowed' : 'denied',
      text: decision.allow
        ? `Allowed${granted ? ` ${grantKey(approval.toolName, approval.input)} for this conversation (up to 4 hours)` : ''}: ${approval.summary}`
        : `Denied: ${approval.summary}${reason !== undefined && reason !== '' ? ` — ${reason}` : ''}`,
    });
    this.ctx.bus?.closeGate(
      conversationId,
      { requestId },
      'the call was decided'
    );
    resolve(decision);
    return this.get(conversationId);
  }

  // ---------------------------------------------------------------------
  // Built-in tool gate
  // ---------------------------------------------------------------------

  // Answers one built-in tool call for the backend. The project's permission
  // policy settles what it can — the executor's own rules, so the overseer
  // and a dispatched run agree on what needs a human: an irreversible command
  // (see floor.ts) always does, whatever the mode or any earlier grant;
  // otherwise `acceptEdits` waves the edit tools through, and a tool the
  // human already allowed for this conversation is allowed again. Everything
  // else parks on the record until `decideApproval`.
  private authorizeTool(
    conversationId: string,
    permissionMode: string,
    request: OverseerToolRequest
  ): Promise<ApprovalDecision> {
    const { requestId, toolName, input } = request;
    const record = this.conversations.get(conversationId);
    // The floor and the Overseer's holds always ask, whatever the mode or any grant.
    const held =
      floorCheckForToolInput(input) !== null || request.check !== undefined;
    if (!held) {
      if (
        permissionMode === 'acceptEdits' &&
        AUTO_ALLOWED_EDIT_TOOLS.has(toolName)
      ) {
        return Promise.resolve({ allow: true });
      }
      if (
        this.grants.allows(
          conversationId,
          grantKey(toolName, input),
          Date.now(),
          record?.sessionId
        )
      ) {
        return Promise.resolve({ allow: true });
      }
    }
    if (record === undefined) {
      return Promise.resolve({ allow: false, reason: TURN_ENDED_DENIAL });
    }
    const approval: OverseerApproval = {
      requestId,
      toolName,
      input,
      summary: describeToolCall(toolName, input),
      requestedAt: new Date().toISOString(),
      ...(held ? { held: true } : {}),
    };
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolvers.set(requestId, resolve);
      this.updateRecord(conversationId, {
        pendingApprovals: [...record.pendingApprovals, approval],
      });
      this.appendMessage(conversationId, {
        role: 'approval',
        tool: toolName,
        requestId,
        outcome: 'pending',
        text: approval.summary,
      });
      void this.raiseApprovalGate(conversationId, approval);
    });
  }

  // Asks the owner about a parked call through a gate. A call settled while the
  // gate was written closes it; one nobody can be asked about is denied.
  private async raiseApprovalGate(
    conversationId: string,
    approval: OverseerApproval
  ): Promise<void> {
    const bus = this.ctx.bus;
    if (bus === undefined) return;
    const { requestId } = approval;
    try {
      await bus.raiseToolApproval(conversationId, approval);
    } catch (err) {
      console.error(
        `overseer: could not raise a tool-approval gate for ${conversationId}`,
        err
      );
      if (!this.isParked(conversationId, requestId)) return;
      const why = err instanceof Error ? err.message : String(err);
      this.decideApproval(conversationId, requestId, {
        allow: false,
        reason: `Dispatch could not ask a human: ${why}`,
      });
      return;
    }
    if (!this.isParked(conversationId, requestId))
      bus.closeGate(
        conversationId,
        { requestId },
        'the call was already settled'
      );
  }

  private isParked(conversationId: string, requestId: string): boolean {
    return (
      this.approvalResolvers.has(requestId) &&
      this.conversations
        .get(conversationId)
        ?.pendingApprovals.some((a) => a.requestId === requestId) === true
    );
  }

  // Denies every call still parked on a conversation whose turn is over.
  private sweepApprovals(conversationId: string): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined || record.pendingApprovals.length === 0) return;
    for (const approval of record.pendingApprovals) {
      const resolve = this.approvalResolvers.get(approval.requestId);
      this.approvalResolvers.delete(approval.requestId);
      resolve?.({ allow: false, reason: TURN_ENDED_DENIAL });
      this.appendMessage(conversationId, {
        role: 'approval',
        tool: approval.toolName,
        requestId: approval.requestId,
        outcome: 'denied',
        text: `Denied: ${approval.summary} — ${TURN_ENDED_DENIAL}`,
      });
      this.ctx.bus?.closeGate(
        conversationId,
        { requestId: approval.requestId },
        TURN_ENDED_DENIAL
      );
    }
    this.updateRecord(conversationId, { pendingApprovals: [] });
  }

  // ---------------------------------------------------------------------
  // Tool plumbing
  // ---------------------------------------------------------------------

  // The toolset one turn of `conversationId` gets. Bound to the conversation
  // so every call lands on the right transcript, and built per turn rather
  // than once per conversation so a tool added to the registry shows up on the
  // next turn rather than only for new conversations.
  private toolsetFor(conversationId: string): OverseerToolset {
    const { registry } = this.ctx;
    const tools: OverseerToolDescriptor[] = [
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
  // can fix its call, exactly like the registry's own OverseerToolError contract.
  private callTool(
    conversationId: string,
    name: string,
    input: unknown
  ): OverseerToolResult {
    const { registry } = this.ctx;
    const mutating = registry.mutatingTools().some((t) => t.name === name);
    const known =
      mutating || registry.statusTools().some((t) => t.name === name);
    try {
      if (!known) throw new Error(`unknown overseer tool: ${name}`);
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
      const owner = this.conversations.get(conversationId)?.owner;
      const data = registry.callStatusTool(name, input, {
        ...(owner !== undefined ? { owner } : {}),
      });
      this.appendMessage(conversationId, {
        role: 'tool',
        tool: name,
        text: registry.transcriptFor(name, data) ?? describeToolResult(data),
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

  // Records a queued action on the confirmation list and the transcript, and
  // asks the owner to confirm it through a gate.
  private queueAction(conversationId: string, action: OverseerAction): void {
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
    void this.raiseActionGate(conversationId, action);
  }

  // Raises an action's gate, replacing an open one with the last error if any;
  // a gate written after its action was decided closes at once. Never rejects.
  private async raiseActionGate(
    conversationId: string,
    action: OverseerAction,
    lastError?: string
  ): Promise<void> {
    const bus = this.ctx.bus;
    if (bus === undefined) return;
    if (lastError !== undefined)
      bus.closeGate(
        conversationId,
        { actionId: action.id },
        'the action is asked about again'
      );
    try {
      await bus.raiseAction(conversationId, {
        id: action.id,
        summary: action.summary,
        ...(lastError !== undefined ? { lastError } : {}),
      });
    } catch (err) {
      console.error(
        `overseer: could not raise a gate for action ${action.id}`,
        err
      );
      return;
    }
    const pending = this.conversations
      .get(conversationId)
      ?.pendingActions.some((a) => a.id === action.id);
    if (pending !== true)
      bus.closeGate(
        conversationId,
        { actionId: action.id },
        'the action was already decided'
      );
  }

  // Drops a decided action off the confirmation list, appends the transcript
  // entry recording what happened to it, and queues the same news for the
  // model's next turn.
  private settleAction(
    conversationId: string,
    action: OverseerAction,
    outcome: 'applied' | 'denied'
  ): void {
    this.dropPendingAction(conversationId, action.id);
    this.ctx.bus?.closeGate(
      conversationId,
      { actionId: action.id },
      `the action was ${outcome}`
    );
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
    action: OverseerAction
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

  // Posts entry `index` to the thread: `speaker`'s line, or the reply to their
  // line at `answers`. A turn no human spoke stays off the bus.
  private postEntry(
    conversationId: string,
    index: number,
    speaker: Sender | null,
    answers?: number
  ): void {
    const bus = this.ctx.bus;
    if (bus === undefined) return;
    if (speaker === null) {
      if (!this.loggedOffBus.has(conversationId)) {
        this.loggedOffBus.add(conversationId);
        console.log(
          `overseer: ${conversationId} has turns from no human speaker; they stay off the bus`
        );
      }
      return;
    }
    const previous = this.posts.get(conversationId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const record = this.conversations.get(conversationId);
        const entry = record?.messages[index];
        if (record === undefined || entry === undefined) return;
        if (answers !== undefined) {
          // A line the bus refused gets no reply there either.
          const line = record.messages[answers]?.messageId;
          if (line === undefined) return;
          const posted = await bus.post({
            overseerTo: speaker.address,
            text: entry.text,
            replyTo: line,
          });
          this.tagEntry(conversationId, index, posted);
          return;
        }
        const replyTo =
          record.messages.findLast((m) => m.messageId !== undefined)
            ?.messageId ?? null;
        const posted = await bus.post({ speaker, text: entry.text, replyTo });
        this.tagEntry(conversationId, index, posted);
      })
      .catch((err: unknown) => {
        // Refused (breaker, size, revoked, not a participant): the record
        // keeps the line without a messageId.
        console.error(
          `overseer: could not post a line of ${conversationId} to the bus`,
          err
        );
      });
    this.posts.set(conversationId, next);
  }

  // Records where a posted entry landed; the first one's thread is the
  // conversation's.
  private tagEntry(
    conversationId: string,
    index: number,
    posted: Message
  ): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    this.updateRecord(conversationId, {
      thread: record.thread ?? posted.thread,
      messages: record.messages.map((m, i) =>
        i === index ? { ...m, messageId: posted.id } : m
      ),
    });
  }

  // Appends one transcript entry, stamped now.
  private appendMessage(
    conversationId: string,
    message: Omit<OverseerMessage, 'at'>
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
    patch: Partial<OverseerRecord>
  ): void {
    const record = this.conversations.get(conversationId);
    if (record === undefined) return;
    const updated: OverseerRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.conversations.set(conversationId, updated);
    this.persist(updated);
    this.ctx.events.broadcast({ type: 'overseer.changed', conversationId });
  }
}

// Rejects once `signal` aborts; never settles otherwise.
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), {
      once: true,
    });
  });
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
