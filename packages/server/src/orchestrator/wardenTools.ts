import { untrustedInline } from '@dispatch/core';
import type { LedgerEntry, TaskDoc, TaskStorePort } from '@dispatch/core';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { TaskCache } from '../cache.js';
import type { LedgerStorePort } from '../ledger.js';
import type { MergeQueue, MergeQueueEntry } from './mergeQueue.js';
import type { Orchestrator } from './orchestrator.js';
import type { QuestionRegistry, RunQuestion } from './questions.js';
import type { RunMeta } from './types.js';
import { TERMINAL_RUN_STATES } from './types.js';

/**
 * The warden's private tool surface: read-only status tools over everything
 * the Control room's feed already shows, plus mutating tools that never
 * mutate on their own.
 *
 * Deliberately NOT registered in packages/mcp. Every tool here acts with the
 * daemon operator's authority — dispatching work, answering approvals,
 * cancelling runs — which is exactly the authority a task-running agent must
 * not have. The MCP server is the surface reachable by those agents; this one
 * is reachable only by the warden chat session.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A tool call the warden got wrong: an unknown tool name, input that fails its
 * zod schema, or a target that doesn't exist. Mirrors packages/mcp/src/tools.ts's
 * own ToolError — the point is the same, that the calling model can read the
 * message and self-correct rather than the call failing at the protocol layer.
 */
export class WardenToolError extends Error {}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Everything the tools read and write through.
 *
 * Shaped like OrchestratorContext (store/cache) but bundling the peers the
 * status tools need, because the merge queue, question registry and ledger are
 * NOT owned by the Orchestrator — they are assembled alongside it in api.ts's
 * ApiContext. Taking them explicitly is what keeps this constructible in a
 * test without booting an HTTP server.
 *
 * There is deliberately no `events` here: every mutation below goes through
 * Orchestrator or MergeQueue, both of which broadcast their own events, so a
 * bus on this context would only be a second, easily-desynced way to do it.
 */
export interface WardenToolContext {
  store: TaskStorePort;
  cache: TaskCache;
  orchestrator: Orchestrator;
  mergeQueue: MergeQueue;
  questions: QuestionRegistry;
  ledgerStore: LedgerStorePort;
  /**
   * Executor `dispatch_task` uses when the warden doesn't name one. Matches
   * api.ts's own fallback rather than being configurable per call site, so
   * warden-dispatched runs are indistinguishable from UI-dispatched ones.
   */
  defaultExecutor?: string;
}

const DEFAULT_EXECUTOR = 'claude';

// Resolves the executor a dispatch action runs on: an explicit choice, else
// this project's configured default, else the same name api.ts falls back to.
function executorFor(ctx: WardenToolContext, chosen?: string): string {
  return chosen ?? ctx.defaultExecutor ?? DEFAULT_EXECUTOR;
}

// ---------------------------------------------------------------------------
// Tool shapes
// ---------------------------------------------------------------------------

/** A read-only tool. Returns data; never touches the orchestrator's write paths. */
export interface WardenStatusTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  read(ctx: WardenToolContext, input: Input): Output;
}

/**
 * A tool whose call produces a *proposal*, not an effect.
 *
 * `describe` runs at call time: it validates that the target exists and
 * returns the sentence a human reads before confirming. `apply` runs only from
 * WardenToolRegistry.applyAction, after that confirmation.
 */
export interface WardenMutatingTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  describe(ctx: WardenToolContext, input: Input): string;
  apply(ctx: WardenToolContext, input: Input): Promise<void> | void;
}

/** A mutating tool call awaiting (or past) human confirmation. */
export interface WardenAction {
  id: string;
  /** The mutating tool this action would invoke. */
  tool: string;
  /** The validated input, exactly as `apply` will receive it. */
  input: unknown;
  /** One sentence, safe to render verbatim in the chat UI. */
  summary: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'denied';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Shared by the status tools that take no arguments at all. Still a real
// schema rather than a skipped parse, so `{ runId: 'r-1' }` sent to a tool
// that ignores it is reported instead of silently doing something else.
const noInput = z.strictObject({});
type NoInput = z.infer<typeof noInput>;

// The task fields status tools return. Same reasoning as tools.ts's
// taskSummaryShape: no body, so a listing of a large board stays small.
const taskSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  parent: z.string().nullable(),
  priority: z.string(),
  assignee: z.string(),
  blockedBy: z.array(z.string()),
});

type TaskSummary = z.infer<typeof taskSummarySchema>;

function toSummary(doc: TaskDoc): TaskSummary {
  const { id, title, status, kind, parent, priority, assignee, blockedBy } =
    doc.meta;
  return { id, title, status, kind, parent, priority, assignee, blockedBy };
}

// Task titles are authored by agents and rendered straight into the chat UI's
// confirmation prompt, so they get the same line-break flattening every other
// untrusted string in a dispatch prompt gets.
function safeTitle(title: string): string {
  return untrustedInline(title);
}

// Looks a task up the same way the API's own handlers do — via the cache,
// falling back to the store so a task written since the last rebuild is still
// found rather than reported missing.
function requireTask(ctx: WardenToolContext, taskId: string): TaskDoc {
  const doc = ctx.cache.get(taskId) ?? ctx.store.get(taskId);
  if (doc === null) throw new WardenToolError(`task not found: ${taskId}`);
  return doc;
}

function requireRun(ctx: WardenToolContext, runId: string): RunMeta {
  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) throw new WardenToolError(`run not found: ${runId}`);
  return detail.meta;
}

function isLive(meta: RunMeta): boolean {
  return !TERMINAL_RUN_STATES.has(meta.state);
}

// ---------------------------------------------------------------------------
// Status tools
// ---------------------------------------------------------------------------

const listRunsInput = z.object({
  /** Include runs that have already reached a terminal state. */
  includeTerminal: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const runSummaryFields = (meta: RunMeta) => ({
  id: meta.id,
  taskId: meta.taskId,
  taskTitle: meta.taskTitle,
  state: meta.state,
  branch: meta.branch,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  live: isLive(meta),
  reviewedAt: meta.reviewedAt ?? null,
  error: meta.error ?? null,
});

const listRuns: WardenStatusTool<z.infer<typeof listRunsInput>> = {
  name: 'list_runs',
  description:
    'Live and recent runs for this project, most-recent-first. Omit ' +
    'includeTerminal to see only runs that are still going.',
  inputSchema: listRunsInput,
  read(ctx, input) {
    const all = ctx.orchestrator.list();
    const filtered =
      input.includeTerminal === true ? all : all.filter((m) => isLive(m));
    const limited =
      input.limit === undefined ? filtered : filtered.slice(0, input.limit);
    return {
      runs: limited.map(runSummaryFields),
      total: filtered.length,
    };
  },
};

const readyTasksTool: WardenStatusTool<NoInput> = {
  name: 'list_ready_tasks',
  description:
    'Tasks that are safe to dispatch right now: unblocked, in priority order.',
  inputSchema: noInput,
  read(ctx) {
    const ready = ctx.cache.ready();
    return { tasks: ready.map(toSummary), total: ready.length };
  },
};

const blockedTasksTool: WardenStatusTool<NoInput> = {
  name: 'list_blocked_tasks',
  description:
    'Tasks held up by at least one blocker that is not yet done or cancelled, ' +
    'each with the blockers still holding it.',
  inputSchema: noInput,
  read(ctx) {
    const all = ctx.cache.query();
    const byId = new Map(all.map((t) => [t.meta.id, t]));
    // Same rule as the desktop board's computeBlockedIds: a blocker id with no
    // matching task is dangling, not blocking. Duplicated rather than imported
    // because that helper lives in the desktop app, which the server does not
    // (and must not) depend on.
    const blocked = all
      .map((doc) => ({
        doc,
        blockers: doc.meta.blockedBy.filter((id) => {
          const blocker = byId.get(id);
          return (
            blocker !== undefined &&
            blocker.meta.status !== 'done' &&
            blocker.meta.status !== 'cancelled'
          );
        }),
      }))
      .filter((row) => row.blockers.length > 0);
    return {
      tasks: blocked.map((row) => ({
        ...toSummary(row.doc),
        blockedByOpen: row.blockers,
      })),
      total: blocked.length,
    };
  },
};

function mergeEntryFields(entry: MergeQueueEntry) {
  return {
    runId: entry.runId,
    taskId: entry.taskId,
    taskTitle: entry.taskTitle,
    state: entry.state,
    reason: entry.reason ?? null,
    enqueuedAt: entry.enqueuedAt,
    finishedAt: entry.finishedAt ?? null,
  };
}

const mergeQueueTool: WardenStatusTool<NoInput> = {
  name: 'merge_queue',
  description:
    'The merge queue: entries waiting or in flight, plus recent merged/failed history.',
  inputSchema: noInput,
  read(ctx) {
    const snapshot = ctx.mergeQueue.snapshot();
    return {
      entries: snapshot.entries.map(mergeEntryFields),
      history: snapshot.history.map(mergeEntryFields),
    };
  },
};

const pendingApprovalsTool: WardenStatusTool<NoInput> = {
  name: 'pending_approvals',
  description:
    'Tool calls that live runs are parked on, waiting for a human to allow or deny.',
  inputSchema: noInput,
  read(ctx) {
    const pending = ctx.orchestrator.pendingApprovals();
    return { approvals: pending, total: pending.length };
  },
};

const openQuestionsInput = z.object({
  /** Narrow to one run's questions; omit for every open question in the project. */
  runId: z.string().optional(),
});

function questionFields(question: RunQuestion) {
  return {
    id: question.id,
    runId: question.runId,
    question: question.question,
    options: question.options,
    askedAt: question.askedAt,
  };
}

const openQuestionsTool: WardenStatusTool<z.infer<typeof openQuestionsInput>> =
  {
    name: 'open_questions',
    description:
      'Questions run agents have asked and are still blocked waiting on an answer to.',
    inputSchema: openQuestionsInput,
    read(ctx, input) {
      const open = ctx.questions.listOpen(input.runId);
      return { questions: open.map(questionFields), total: open.length };
    },
  };

const ledgerInput = z.object({
  /** Scope to one epic's entries; omit for every entry in the project. */
  epicId: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

function ledgerFields(entry: LedgerEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    detail: entry.detail,
    appliesTo: entry.appliesTo,
    createdAt: entry.createdAt,
  };
}

const ledgerTool: WardenStatusTool<z.infer<typeof ledgerInput>> = {
  name: 'ledger_entries',
  description:
    'Findings and decisions earlier runs recorded for later ones to build on.',
  inputSchema: ledgerInput,
  read(ctx, input) {
    const entries = ctx.ledgerStore.list(
      input.epicId === undefined ? {} : { epicId: input.epicId }
    );
    const limited =
      input.limit === undefined ? entries : entries.slice(0, input.limit);
    return { entries: limited.map(ledgerFields), total: entries.length };
  },
};

export const WARDEN_STATUS_TOOLS: readonly WardenStatusTool[] = [
  listRuns,
  readyTasksTool,
  blockedTasksTool,
  mergeQueueTool,
  pendingApprovalsTool,
  openQuestionsTool,
  ledgerTool,
] as WardenStatusTool[];

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

const dispatchInput = z.object({
  taskId: z.string(),
  executor: z.string().optional(),
  model: z.string().optional(),
});

const dispatchTask: WardenMutatingTool<z.infer<typeof dispatchInput>> = {
  name: 'dispatch_task',
  description: 'Start an agent run on a task.',
  inputSchema: dispatchInput,
  describe(ctx, input) {
    const doc = requireTask(ctx, input.taskId);
    const model = input.model === undefined ? '' : ` on model ${input.model}`;
    return `Dispatch ${doc.meta.id} "${safeTitle(doc.meta.title)}" with the ${executorFor(ctx, input.executor)} executor${model}`;
  },
  async apply(ctx, input) {
    // `actor` is deliberately omitted here and in message_run: the
    // orchestrator's default credits the daemon's human, and a human
    // confirming the action in the chat UI is precisely who caused it. The
    // explicit 'none' actor is for callers with no human behind them at all
    // (EpicEngine's auto-fill), which the warden never is.
    await ctx.orchestrator.dispatch(
      input.taskId,
      executorFor(ctx, input.executor),
      { model: input.model }
    );
  },
};

// Both approve_run and deny_run resolve the requestId from the run itself
// rather than making the warden carry one: the requestId it saw in a
// pending_approvals result may already be stale by confirmation time, and
// answering the wrong request is worse than refusing. Resolved twice on
// purpose — once in `describe` so the summary can name the tool being
// approved, once in `apply` so a request that rotated in between is caught.
function requireApproval(ctx: WardenToolContext, runId: string) {
  const meta = requireRun(ctx, runId);
  const pending = ctx.orchestrator.pendingApprovalFor(runId);
  if (pending === undefined) {
    throw new WardenToolError(`run is not awaiting approval: ${runId}`);
  }
  return { meta, pending };
}

const approveInput = z.object({
  runId: z.string(),
  /** 'session' also pre-approves the same tool for the rest of the run. */
  scope: z.enum(['once', 'session']).optional(),
});

const approveRun: WardenMutatingTool<z.infer<typeof approveInput>> = {
  name: 'approve_run',
  description:
    'Allow the tool call a run is currently parked on, letting it continue.',
  inputSchema: approveInput,
  describe(ctx, input) {
    const { meta, pending } = requireApproval(ctx, input.runId);
    const scope =
      input.scope === 'session' ? ' for the rest of the session' : '';
    return `Approve ${safeTitle(pending.toolName)} on run ${meta.id} ("${safeTitle(meta.taskTitle)}")${scope}`;
  },
  apply(ctx, input) {
    const { pending } = requireApproval(ctx, input.runId);
    ctx.orchestrator.approve(input.runId, pending.requestId, {
      allow: true,
      scope: input.scope ?? 'once',
    });
  },
};

const denyInput = z.object({
  runId: z.string(),
  reason: z.string().optional(),
});

const denyRun: WardenMutatingTool<z.infer<typeof denyInput>> = {
  name: 'deny_run',
  description:
    'Refuse the tool call a run is currently parked on. This ends the run as ' +
    'failed — the reason, if given, is what it reports as the failure.',
  inputSchema: denyInput,
  describe(ctx, input) {
    const { meta, pending } = requireApproval(ctx, input.runId);
    const why =
      input.reason === undefined ? '' : `: ${safeTitle(input.reason)}`;
    return `Deny ${safeTitle(pending.toolName)} on run ${meta.id} ("${safeTitle(meta.taskTitle)}")${why}`;
  },
  apply(ctx, input) {
    const { pending } = requireApproval(ctx, input.runId);
    ctx.orchestrator.approve(input.runId, pending.requestId, {
      allow: false,
      reason: input.reason,
    });
  },
};

const cancelInput = z.object({ runId: z.string() });

const cancelRun: WardenMutatingTool<z.infer<typeof cancelInput>> = {
  name: 'cancel_run',
  description:
    'Stop a live run. Its worktree and branch are left in place for review.',
  inputSchema: cancelInput,
  describe(ctx, input) {
    const meta = requireRun(ctx, input.runId);
    if (!isLive(meta)) {
      throw new WardenToolError(`run already finished: ${meta.id}`);
    }
    return `Cancel run ${meta.id} ("${safeTitle(meta.taskTitle)}")`;
  },
  async apply(ctx, input) {
    await ctx.orchestrator.cancel(input.runId);
  },
};

const dequeueInput = z.object({ runId: z.string() });

const dequeueMerge: WardenMutatingTool<z.infer<typeof dequeueInput>> = {
  name: 'dequeue_merge',
  description:
    'Pull a run out of the merge queue. The entry being processed right now cannot be pulled.',
  inputSchema: dequeueInput,
  describe(ctx, input) {
    const entry = ctx.mergeQueue
      .snapshot()
      .entries.find((e) => e.runId === input.runId);
    if (entry === undefined) {
      throw new WardenToolError(`run not found in merge queue: ${input.runId}`);
    }
    return `Remove run ${entry.runId} ("${safeTitle(entry.taskTitle)}") from the merge queue`;
  },
  apply(ctx, input) {
    ctx.mergeQueue.remove(input.runId);
  },
};

const messageInput = z.object({
  runId: z.string(),
  text: z.string().min(1),
});

const messageRun: WardenMutatingTool<z.infer<typeof messageInput>> = {
  name: 'message_run',
  description:
    'Send a message to a live run, as the human. Only valid while the run is still going.',
  inputSchema: messageInput,
  describe(ctx, input) {
    const meta = requireRun(ctx, input.runId);
    if (!isLive(meta)) {
      throw new WardenToolError(`run is not live: ${meta.id}`);
    }
    return `Message run ${meta.id} ("${safeTitle(meta.taskTitle)}"): ${safeTitle(input.text)}`;
  },
  apply(ctx, input) {
    ctx.orchestrator.sendMessage(input.runId, input.text);
  },
};

export const WARDEN_MUTATING_TOOLS: readonly WardenMutatingTool[] = [
  dispatchTask,
  approveRun,
  denyRun,
  cancelRun,
  dequeueMerge,
  messageRun,
] as WardenMutatingTool[];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The warden's tool surface, bound to one project's context.
 *
 * The invariant this class exists to enforce: calling a mutating tool records
 * a pending WardenAction and returns it. `applyAction(id)` is the ONLY method
 * that reaches a real orchestrator/store mutation, and it is never called from
 * `callMutatingTool`. That split is what lets the chat UI put a human between
 * the model deciding to cancel a run and the run actually being cancelled.
 */
export class WardenToolRegistry {
  private readonly actions = new Map<string, WardenAction>();
  private readonly statusByName = new Map<string, WardenStatusTool>();
  private readonly mutatingByName = new Map<string, WardenMutatingTool>();

  constructor(
    private readonly ctx: WardenToolContext,
    // Injected so a test can pin an action's `createdAt` rather than reading
    // the wall clock. Action ids stay random either way — they must not be
    // guessable from a timestamp, since confirming one is what executes it.
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    for (const tool of WARDEN_STATUS_TOOLS) {
      this.statusByName.set(tool.name, tool);
    }
    for (const tool of WARDEN_MUTATING_TOOLS) {
      this.mutatingByName.set(tool.name, tool);
    }
  }

  statusTools(): readonly WardenStatusTool[] {
    return WARDEN_STATUS_TOOLS;
  }

  mutatingTools(): readonly WardenMutatingTool[] {
    return WARDEN_MUTATING_TOOLS;
  }

  private mintId(): string {
    let id = `wa-${randomBytes(3).toString('hex')}`;
    while (this.actions.has(id)) id = `wa-${randomBytes(3).toString('hex')}`;
    return id;
  }

  // Parses `raw` against a tool's schema, restating zod's issue list as the
  // one-line message shape the rest of this module throws — a model reading a
  // tool error gets a sentence, not a serialized ZodError.
  private parse<Input>(
    tool: { name: string; inputSchema: z.ZodType<Input> },
    raw: unknown
  ): Input {
    const result = tool.inputSchema.safeParse(raw);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.');
          return path === '' ? issue.message : `${path}: ${issue.message}`;
        })
        .join('; ');
      throw new WardenToolError(`invalid input for ${tool.name}: ${detail}`);
    }
    return result.data;
  }

  /** Runs a read-only tool and returns its data. */
  callStatusTool(name: string, raw: unknown = {}): unknown {
    const tool = this.statusByName.get(name);
    if (tool === undefined) {
      throw new WardenToolError(`unknown status tool: ${name}`);
    }
    return tool.read(this.ctx, this.parse(tool, raw));
  }

  /**
   * Validates a mutating tool call and records it as pending. Performs no part
   * of the effect — see applyAction.
   */
  callMutatingTool(name: string, raw: unknown = {}): WardenAction {
    const tool = this.mutatingByName.get(name);
    if (tool === undefined) {
      throw new WardenToolError(`unknown mutating tool: ${name}`);
    }
    const input = this.parse(tool, raw);
    // Throws on a target that doesn't exist or isn't in a state this tool can
    // act on, so the warden finds out while it can still say something useful
    // — rather than the human confirming an action that was never going to work.
    const summary = tool.describe(this.ctx, input);
    const action: WardenAction = {
      id: this.mintId(),
      tool: tool.name,
      input,
      summary,
      createdAt: this.now(),
      status: 'pending',
    };
    this.actions.set(action.id, action);
    return action;
  }

  getAction(id: string): WardenAction | undefined {
    return this.actions.get(id);
  }

  /** Every action still awaiting a decision, oldest first. */
  listPending(): WardenAction[] {
    return [...this.actions.values()].filter((a) => a.status === 'pending');
  }

  /**
   * Performs a confirmed action's real effect. The one path in this module
   * that mutates anything.
   *
   * An action can only be applied once: a second call finds it no longer
   * `pending` and refuses, so a double-confirm (two clicks, a retried request)
   * can't dispatch two runs or cancel a run twice.
   */
  async applyAction(id: string): Promise<WardenAction> {
    const action = this.requirePending(id, 'apply');
    const tool = this.mutatingByName.get(action.tool);
    // Only reachable if the tool list changed under a still-pending action.
    if (tool === undefined) {
      throw new WardenToolError(`unknown mutating tool: ${action.tool}`);
    }
    // Claimed BEFORE the await, not after. requirePending alone only stops a
    // SEQUENTIAL second apply: with the flip after the await, two calls racing
    // each other both pass the check and both run — which is precisely the
    // double-click this guard exists to stop.
    action.status = 'applied';
    try {
      await tool.apply(this.ctx, action.input);
    } catch (err) {
      // Back to `pending` because the effect did not happen: leaving it
      // `applied` would lie, and `denied` would discard an action the human
      // explicitly approved and may well want to retry.
      action.status = 'pending';
      throw err;
    }
    return action;
  }

  /** Records that the human refused this action. Nothing is executed. */
  denyAction(id: string): WardenAction {
    const action = this.requirePending(id, 'deny');
    action.status = 'denied';
    return action;
  }

  private requirePending(id: string, verb: string): WardenAction {
    const action = this.actions.get(id);
    if (action === undefined) {
      throw new WardenToolError(`unknown action: ${id}`);
    }
    if (action.status !== 'pending') {
      throw new WardenToolError(
        `cannot ${verb} an action that is already ${action.status}: ${id}`
      );
    }
    return action;
  }
}
