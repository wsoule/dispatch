import {
  isDoneStatus,
  notificationKindForMessage,
  untrustedInline,
  untrustedVerbatim,
} from '@dispatch-foo/core';
import type { LedgerEntry, TaskDoc, TaskStorePort } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import { gateOf } from '@dispatch-foo/protocol';
import { MEMORY_KINDS } from '@dispatch/memory';
import type { MemoryKind, SharedScope } from '@dispatch/memory';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { TaskCache } from '../cache.js';
import type { DocsService } from '../docs/service.js';
import type { LedgerStorePort } from '../ledger.js';
import { classifyLedgerEntry } from '../memory/ledgerImport.js';
import { statusModelFor } from '../statuses.js';
import type { MergeQueue, MergeQueueEntry } from './mergeQueue.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  actingOperator,
  runMessageRefusal,
  TERMINAL_RUN_STATES,
} from './types.js';

/**
 * The overseer's private tool surface: read-only status tools over everything
 * the Control room's feed already shows, plus mutating tools that never
 * mutate on their own.
 *
 * Deliberately NOT registered in packages/mcp. Every tool here acts with the
 * daemon operator's authority — dispatching work, answering approvals,
 * cancelling runs — which is exactly the authority a task-running agent must
 * not have. The MCP server is the surface reachable by those agents; this one
 * is reachable only by the overseer chat session.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A tool call the overseer got wrong: an unknown tool name, input that fails its
 * zod schema, or a target that doesn't exist. Mirrors packages/mcp/src/tools.ts's
 * own ToolError — the point is the same, that the calling model can read the
 * message and self-correct rather than the call failing at the protocol layer.
 */
export class OverseerToolError extends Error {}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Everything the tools read and write through.
 *
 * Shaped like OrchestratorContext (store/cache) but bundling the peers the
 * status tools need, because the merge queue, the open gates and the ledger are
 * NOT owned by the Orchestrator — they are assembled alongside it in api.ts's
 * ApiContext. Taking them explicitly is what keeps this constructible in a
 * test without booting an HTTP server.
 *
 * There is deliberately no `events` here: every mutation below goes through
 * Orchestrator, MergeQueue or the message bus, each of which broadcasts its own
 * events, so an event bus here would only be a second way to do it.
 */
export interface OverseerToolContext {
  store: TaskStorePort;
  cache: TaskCache;
  orchestrator: Orchestrator;
  mergeQueue: MergeQueue;
  /** Open blocking questions addressed to a human (see openHumanDecisions). */
  openGates: () => Message[];
  ledgerStore: LedgerStorePort;
  /** Project and team memory reads; the overseer has no personal scope. */
  memory?: {
    search(input: {
      query: string;
      scope?: SharedScope;
      kind?: MemoryKind;
      limit?: number;
    }): unknown;
    read(ref: string): unknown;
  };
  /** The message bus, for the tools that answer a run's tool-approval gate or
   *  message a run, as the human who confirmed the action (`actor`). */
  messaging: {
    answerRunApproval(
      runId: string,
      requestId: string,
      answer: { choice: 'approve' | 'approve-session' | 'deny'; body: string },
      actor: string
    ): Promise<void>;
    /** `data.draftedBy` names the agent that wrote the text, shown to readers. */
    sendAsHuman(
      to: string,
      text: string,
      actor: string,
      data?: { draftedBy?: string }
    ): Promise<void>;
  };
  /** The daemon's human: the overseer acts for them, so its runs do too. */
  ownerRef: string;
  /** The overseer's own address, credited as drafter of what it sends as a human. */
  overseer?: string;
  /** Team docs, read as the owner; absent or null when the docs service is not wired. */
  docs?: Pick<
    DocsService,
    'available' | 'overseerActor' | 'list' | 'search' | 'read'
  > | null;
  /**
   * Executor `dispatch_task` uses when the overseer doesn't name one. Matches
   * api.ts's own fallback rather than being configurable per call site, so
   * overseer-dispatched runs are indistinguishable from UI-dispatched ones.
   */
  defaultExecutor?: string;
}

// Resolves the executor a dispatch action runs on: an explicit choice, else
// this context's override, else the project's configured default executor.
function executorFor(ctx: OverseerToolContext, chosen?: string): string {
  return (
    chosen ?? ctx.defaultExecutor ?? ctx.orchestrator.defaultExecutorName()
  );
}

// ---------------------------------------------------------------------------
// Tool shapes
// ---------------------------------------------------------------------------

/** A read-only tool. Returns data; never touches the orchestrator's write paths. */
export interface OverseerStatusTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  read(ctx: OverseerToolContext, input: Input): Output;
}

/** Who confirmed an action, and whether with the owner's app token. */
export interface ConfirmedBy {
  actor: string;
  ownerCredential?: boolean;
  /** Whether whoever confirmed holds decide tier; absent means they do not. */
  canDecide?: boolean;
}

/**
 * A tool whose call produces a *proposal*, not an effect.
 *
 * `describe` runs at call time: it validates that the target exists and
 * returns the sentence a human reads before confirming. `apply` runs only from
 * OverseerToolRegistry.applyAction, after that confirmation; `meta.actor` is
 * the human who confirmed it.
 */
export interface OverseerMutatingTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  /** Fills in at call time what the input leaves to the live state, so
   *  `apply` acts on exactly what `describe` showed the human. */
  pin?(ctx: OverseerToolContext, input: Input): Input;
  describe(ctx: OverseerToolContext, input: Input): string;
  apply(
    ctx: OverseerToolContext,
    input: Input,
    meta: ConfirmedBy
  ): Promise<void> | void;
}

/** A mutating tool call awaiting (or past) human confirmation. */
export interface OverseerAction {
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
function requireTask(ctx: OverseerToolContext, taskId: string): TaskDoc {
  const doc = ctx.cache.get(taskId) ?? ctx.store.get(taskId);
  if (doc === null) throw new OverseerToolError(`task not found: ${taskId}`);
  return doc;
}

function requireRun(ctx: OverseerToolContext, runId: string): RunMeta {
  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) throw new OverseerToolError(`run not found: ${runId}`);
  return detail.meta;
}

function isLive(meta: RunMeta): boolean {
  return !TERMINAL_RUN_STATES.has(meta.state);
}

// ---------------------------------------------------------------------------
// Status tools
// ---------------------------------------------------------------------------

const listRunsInput = z.object({
  includeTerminal: z
    .boolean()
    .optional()
    .describe(
      'Also include runs that already finished, failed or were cancelled. Omit to list only live runs.'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Most runs to return, newest first. Omit for all of them.'),
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

const listRuns: OverseerStatusTool<z.infer<typeof listRunsInput>> = {
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

const readyTasksTool: OverseerStatusTool<NoInput> = {
  name: 'list_ready_tasks',
  description:
    'Tasks that are safe to dispatch right now: unblocked, in priority order.',
  inputSchema: noInput,
  read(ctx) {
    const ready = ctx.cache.ready(statusModelFor(ctx.store.rootDir));
    return { tasks: ready.map(toSummary), total: ready.length };
  },
};

const blockedTasksTool: OverseerStatusTool<NoInput> = {
  name: 'list_blocked_tasks',
  description:
    'Tasks held up by at least one blocker that has not landed or been dropped, ' +
    'each with the blockers still holding it.',
  inputSchema: noInput,
  read(ctx) {
    const all = ctx.cache.query();
    const statuses = statusModelFor(ctx.store.rootDir);
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
            !isDoneStatus(blocker.meta.status, statuses)
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

const mergeQueueTool: OverseerStatusTool<NoInput> = {
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

const pendingApprovalsTool: OverseerStatusTool<NoInput> = {
  name: 'pending_approvals',
  description:
    'Tool calls that live runs are parked on, waiting for a human to allow or deny.',
  inputSchema: noInput,
  read(ctx) {
    const runs = new Map(ctx.orchestrator.list().map((run) => [run.id, run]));
    const approvals = ctx.openGates().flatMap((message) => {
      const gate = gateOf(message);
      if (gate?.type !== 'tool-approval' || gate.runId === undefined) return [];
      const run = runs.get(gate.runId);
      return [
        {
          messageId: message.id,
          runId: gate.runId,
          taskId: run?.taskId ?? null,
          taskTitle: run?.taskTitle ?? null,
          requestId: gate.requestId,
          toolName: gate.tool,
          // At most an 8 KiB preview; `truncated` says when it was cut, and
          // `floor` whether the full call is an irreversible act.
          input: gate.input,
          truncated: gate.truncated === true,
          floor: gate.floor === true,
        },
      ];
    });
    return { approvals, total: approvals.length };
  },
};

const openQuestionsInput = z.object({
  runId: z
    .string()
    .optional()
    .describe(
      "A run id (r-…) to narrow to that run's questions. Omit for every open question in the project."
    ),
});

const openQuestionsTool: OverseerStatusTool<
  z.infer<typeof openQuestionsInput>
> = {
  name: 'open_questions',
  description:
    'Questions run agents have asked and are still blocked waiting on an answer to.',
  inputSchema: openQuestionsInput,
  read(ctx, input) {
    const questions = ctx.openGates().flatMap((message) => {
      if (notificationKindForMessage(message) !== 'question') return [];
      if (!message.from.startsWith('run:')) return [];
      const runId = message.from.slice('run:'.length);
      if (input.runId !== undefined && runId !== input.runId) return [];
      return [
        {
          messageId: message.id,
          runId,
          question: message.body,
          options: message.choices ?? [],
          askedAt: message.createdAt,
        },
      ];
    });
    return { questions, total: questions.length };
  },
};

const ledgerInput = z.object({
  epicId: z
    .string()
    .optional()
    .describe(
      "An epic id (e-…) to scope to that epic's entries. Omit for every entry in the project."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Most entries to return. Omit for all of them.'),
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

const ledgerTool: OverseerStatusTool<z.infer<typeof ledgerInput>> = {
  name: 'ledger_entries',
  description: 'Audit receipts: policy decisions, holds, grants.',
  inputSchema: ledgerInput,
  read(ctx, input) {
    const entries = ctx.ledgerStore
      .list(input.epicId === undefined ? {} : { epicId: input.epicId })
      .filter((e) => classifyLedgerEntry(e).to === 'audit');
    const limited =
      input.limit === undefined ? entries : entries.slice(0, input.limit);
    return { entries: limited.map(ledgerFields), total: entries.length };
  },
};

// The memory port, or the error a context without one gives the model.
function requireMemory(
  ctx: OverseerToolContext
): NonNullable<OverseerToolContext['memory']> {
  if (ctx.memory === undefined)
    throw new OverseerToolError('memory is not available in this session');
  return ctx.memory;
}

const memorySearchInput = z.object({
  query: z
    .string()
    .describe('Words to search for. Empty returns the top entries.'),
  scope: z.enum(['project', 'team']).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const memorySearchTool: OverseerStatusTool<z.infer<typeof memorySearchInput>> =
  {
    name: 'memory_search',
    description:
      'Search the project and team lessons, conventions and preferences Dispatch remembers, stale ones included.',
    inputSchema: memorySearchInput,
    read(ctx, input) {
      return requireMemory(ctx).search(input);
    },
  };

const memoryReadInput = z.object({
  id: z.string().describe('A #handle from a search, or a full memory id.'),
});

const memoryReadTool: OverseerStatusTool<z.infer<typeof memoryReadInput>> = {
  name: 'memory_read',
  description:
    'Open one project or team memory: its body, who wrote it, and its revisions.',
  inputSchema: memoryReadInput,
  read(ctx, input) {
    // Handles are stored upper-case; the model may type one in any case.
    const id = input.id.trim();
    return requireMemory(ctx).read(id.startsWith('#') ? id.toUpperCase() : id);
  },
};

const docListInput = z.object({
  query: z
    .string()
    .optional()
    .describe('Search section text instead of listing.'),
  taskId: z
    .string()
    .optional()
    .describe("A task id (t-… or e-…) to list that task's linked docs."),
  limit: z.number().int().positive().max(100).optional(),
});

const docListTool: OverseerStatusTool<z.infer<typeof docListInput>> = {
  name: 'doc_list',
  description:
    "The project's team docs: all of them, a task's linked docs, or search hits.",
  inputSchema: docListInput,
  read(ctx, input) {
    if (ctx.docs === undefined || ctx.docs === null || !ctx.docs.available)
      return { available: false };
    const actor = ctx.docs.overseerActor();
    if (input.query !== undefined) {
      return {
        hits: ctx.docs
          .search(actor, { query: input.query, limit: input.limit })
          .map((h) => ({
            ...h,
            heading: untrustedInline(h.heading),
            snippet: untrustedInline(h.snippet),
            title: untrustedInline(h.title),
          })),
      };
    }
    const { docs, total } = ctx.docs.list(actor, {
      taskId: input.taskId,
      limit: input.limit ?? 20,
    });
    return {
      total,
      docs: docs.map((d) => ({
        handle: d.handle,
        title: untrustedInline(d.title),
        status: d.status,
        unreviewed: d.unreviewed,
        rev: d.head.n,
        rel: d.rel,
      })),
    };
  },
};

const docReadInput = z.object({
  doc: z.string().describe('A handle or doc- id.'),
  section: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
});

const docReadTool: OverseerStatusTool<z.infer<typeof docReadInput>> = {
  name: 'doc_read',
  description:
    'One page (32 KiB) of a team doc, or one section of it, fenced as untrusted text.',
  inputSchema: docReadInput,
  read(ctx, input) {
    if (ctx.docs === undefined || ctx.docs === null || !ctx.docs.available)
      return { available: false };
    const r = ctx.docs.read(ctx.docs.overseerActor(), input.doc, {
      section: input.section,
      offset: input.offset,
      page: true,
    });
    return {
      handle: r.doc.handle,
      title: untrustedInline(r.doc.title),
      rev: r.rev.n,
      nextOffset: r.nextOffset,
      text: untrustedVerbatim(
        `doc ${r.doc.handle} rev ${r.rev.n ?? r.rev.id}`,
        r.text
      ),
    };
  },
};

export const OVERSEER_STATUS_TOOLS: readonly OverseerStatusTool[] = [
  listRuns,
  readyTasksTool,
  blockedTasksTool,
  mergeQueueTool,
  pendingApprovalsTool,
  openQuestionsTool,
  ledgerTool,
  memorySearchTool,
  memoryReadTool,
  docListTool,
  docReadTool,
] as OverseerStatusTool[];

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

const dispatchInput = z.object({
  taskId: z.string().describe('The task id (t-…) to run.'),
  executor: z
    .string()
    .optional()
    .describe(
      "Executor name (e.g. claude, codex) for this run only. Omit to use the project's default."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model id for this run only. Omit to use the project's configured model for the executor."
    ),
});

// The human a confirmed dispatch runs for: whoever confirmed it, the owner
// only with the owner's app token, no one for the system or a stand-in.
function confirmedOperator(
  ctx: OverseerToolContext,
  meta: ConfirmedBy
): string | null {
  return actingOperator(
    meta.actor,
    meta.ownerCredential === true,
    ctx.ownerRef
  );
}

const dispatchTask: OverseerMutatingTool<z.infer<typeof dispatchInput>> = {
  name: 'dispatch_task',
  description:
    'Start an agent run on a task, on its own branch and worktree. If the ' +
    "task's last run was left recoverable by a daemon restart and you name " +
    'no different executor or model, this resumes that run instead of ' +
    'starting over. Refused when the task already has a live run, when the ' +
    'executor is unknown, and for review/verify tasks the pipeline creates ' +
    'itself. It does not check blockers — use list_ready_tasks to find work ' +
    'that is safe to start.',
  inputSchema: dispatchInput,
  describe(ctx, input) {
    const doc = requireTask(ctx, input.taskId);
    const model = input.model === undefined ? '' : ` on model ${input.model}`;
    return `Dispatch ${doc.meta.id} "${safeTitle(doc.meta.title)}" with the ${executorFor(ctx, input.executor)} executor${model}`;
  },
  async apply(ctx, input, meta) {
    // `actor` is deliberately omitted here: the orchestrator's default credits
    // the daemon's human, and a human confirming the action is precisely who
    // caused it. The explicit 'none' actor is for callers with no human behind
    // them at all (EpicEngine's auto-fill), which the overseer never is.
    // The run, fresh or resumed, acts for whoever confirmed it.
    // dispatchOrResume, not dispatch: a task whose last run a daemon restart
    // left recoverable is picked back up rather than started over. `executor`
    // and `model` carry what the overseer's caller actually NAMED — the daemon's
    // default executor is passed separately, so defaulting to it never reads
    // as an explicit ask that a resume would have to refuse.
    await ctx.orchestrator.dispatchOrResume(input.taskId, {
      executor: input.executor,
      model: input.model,
      operator: confirmedOperator(ctx, meta),
      defaults: { executor: executorFor(ctx) },
    });
  },
};

// The parked call approve_run and deny_run act on: the named one, else the
// run's oldest, which `pin` then names so the confirm answers that call.
function requireApproval(
  ctx: OverseerToolContext,
  runId: string,
  requestId: string | undefined
) {
  const meta = requireRun(ctx, runId);
  const pending =
    requestId === undefined
      ? ctx.orchestrator.pendingApprovalsFor(runId)[0]
      : ctx.orchestrator.pendingApprovalFor(runId, requestId);
  if (pending === undefined) {
    throw new OverseerToolError(
      requestId === undefined
        ? `run is not awaiting approval: ${runId}`
        : `run ${runId} is not parked on ${requestId}`
    );
  }
  return { meta, pending };
}

// A proposal's parked call, named even when the overseer left it to default.
function pinParkedCall<Input extends { runId: string; requestId?: string }>(
  ctx: OverseerToolContext,
  input: Input
): Input {
  const { pending } = requireApproval(ctx, input.runId, input.requestId);
  return { ...input, requestId: pending.requestId };
}

const REQUEST_ID_INPUT = z
  .string()
  .optional()
  .describe(
    "The parked call's requestId, from pending_approvals; defaults to the run's oldest parked call."
  );

const approveInput = z.object({
  runId: z.string().describe('The run (r-…) parked on a tool call.'),
  requestId: REQUEST_ID_INPUT,
  scope: z
    .enum(['once', 'session'])
    .optional()
    .describe(
      "'once' (the default) allows only this call; 'session' also pre-approves the same tool for the rest of the run."
    ),
});

const approveRun: OverseerMutatingTool<z.infer<typeof approveInput>> = {
  name: 'approve_run',
  description: 'Allow a tool call a run is parked on, letting it continue.',
  inputSchema: approveInput,
  pin: pinParkedCall,
  describe(ctx, input) {
    const { meta, pending } = requireApproval(
      ctx,
      input.runId,
      input.requestId
    );
    const scope =
      input.scope === 'session' ? ' for the rest of the session' : '';
    return `Approve ${safeTitle(pending.toolName)} on run ${meta.id} ("${safeTitle(meta.taskTitle)}")${scope}`;
  },
  async apply(ctx, input, meta) {
    const { pending } = requireApproval(ctx, input.runId, input.requestId);
    await ctx.messaging.answerRunApproval(
      input.runId,
      pending.requestId,
      {
        choice: input.scope === 'session' ? 'approve-session' : 'approve',
        body: '',
      },
      meta.actor
    );
  },
};

const denyInput = z.object({
  runId: z.string().describe('The run (r-…) parked on a tool call.'),
  requestId: REQUEST_ID_INPUT,
  reason: z
    .string()
    .optional()
    .describe('Why, in a sentence; recorded as the run failure.'),
});

const denyRun: OverseerMutatingTool<z.infer<typeof denyInput>> = {
  name: 'deny_run',
  description:
    'Refuse a tool call a run is parked on. This ends the run as ' +
    'failed — the reason, if given, is what it reports as the failure.',
  inputSchema: denyInput,
  pin: pinParkedCall,
  describe(ctx, input) {
    const { meta, pending } = requireApproval(
      ctx,
      input.runId,
      input.requestId
    );
    const why =
      input.reason === undefined ? '' : `: ${safeTitle(input.reason)}`;
    return `Deny ${safeTitle(pending.toolName)} on run ${meta.id} ("${safeTitle(meta.taskTitle)}")${why}`;
  },
  async apply(ctx, input, meta) {
    const { pending } = requireApproval(ctx, input.runId, input.requestId);
    await ctx.messaging.answerRunApproval(
      input.runId,
      pending.requestId,
      { choice: 'deny', body: input.reason ?? '' },
      meta.actor
    );
  },
};

const cancelInput = z.object({
  runId: z.string().describe('The live run (r-…) to stop.'),
});

const cancelRun: OverseerMutatingTool<z.infer<typeof cancelInput>> = {
  name: 'cancel_run',
  description:
    'Stop a live run. Its worktree and branch are left in place for review.',
  inputSchema: cancelInput,
  describe(ctx, input) {
    const meta = requireRun(ctx, input.runId);
    if (!isLive(meta)) {
      throw new OverseerToolError(`run already finished: ${meta.id}`);
    }
    return `Cancel run ${meta.id} ("${safeTitle(meta.taskTitle)}")`;
  },
  async apply(ctx, input) {
    await ctx.orchestrator.cancel(input.runId);
  },
};

const dequeueInput = z.object({
  runId: z.string().describe('The queued run (r-…) to pull out.'),
});

const dequeueMerge: OverseerMutatingTool<z.infer<typeof dequeueInput>> = {
  name: 'dequeue_merge',
  description:
    'Pull a run out of the merge queue. The entry being processed right now cannot be pulled.',
  inputSchema: dequeueInput,
  describe(ctx, input) {
    const entry = ctx.mergeQueue
      .snapshot()
      .entries.find((e) => e.runId === input.runId);
    if (entry === undefined) {
      throw new OverseerToolError(
        `run not found in merge queue: ${input.runId}`
      );
    }
    return `Remove run ${entry.runId} ("${safeTitle(entry.taskTitle)}") from the merge queue`;
  },
  apply(ctx, input) {
    ctx.mergeQueue.remove(input.runId);
  },
};

const messageInput = z.object({
  runId: z.string().describe('The live run (r-…) to message.'),
  text: z
    .string()
    .min(1)
    .describe("The message, delivered as the run agent's next user turn."),
});

const messageRun: OverseerMutatingTool<z.infer<typeof messageInput>> = {
  name: 'message_run',
  description:
    'Send a message to a live run, as the human. Only valid while the run is still going.',
  inputSchema: messageInput,
  describe(ctx, input) {
    const meta = requireRun(ctx, input.runId);
    if (!isLive(meta)) {
      throw new OverseerToolError(`run is not live: ${meta.id}`);
    }
    return `Message run ${meta.id} ("${safeTitle(meta.taskTitle)}"): ${safeTitle(input.text)}`;
  },
  async apply(ctx, input, meta) {
    const refusal = runMessageRefusal(
      requireRun(ctx, input.runId),
      meta.actor,
      meta.canDecide === true
    );
    if (refusal !== null) throw new OverseerToolError(refusal);
    await ctx.messaging.sendAsHuman(
      `run:${input.runId}`,
      input.text,
      meta.actor,
      ctx.overseer === undefined ? undefined : { draftedBy: ctx.overseer }
    );
  },
};

export const OVERSEER_MUTATING_TOOLS: readonly OverseerMutatingTool[] = [
  dispatchTask,
  approveRun,
  denyRun,
  cancelRun,
  dequeueMerge,
  messageRun,
] as OverseerMutatingTool[];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The overseer's tool surface, bound to one project's context.
 *
 * The invariant this class exists to enforce: calling a mutating tool records
 * a pending OverseerAction and returns it. `applyAction(id)` is the ONLY method
 * that reaches a real orchestrator/store mutation, and it is never called from
 * `callMutatingTool`. That split is what lets the chat UI put a human between
 * the model deciding to cancel a run and the run actually being cancelled.
 */
export class OverseerToolRegistry {
  private readonly actions = new Map<string, OverseerAction>();
  private readonly statusByName = new Map<string, OverseerStatusTool>();
  private readonly mutatingByName = new Map<string, OverseerMutatingTool>();

  constructor(
    private readonly ctx: OverseerToolContext,
    // Injected so a test can pin an action's `createdAt` rather than reading
    // the wall clock. Action ids stay random either way — they must not be
    // guessable from a timestamp, since confirming one is what executes it.
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    for (const tool of OVERSEER_STATUS_TOOLS) {
      this.statusByName.set(tool.name, tool);
    }
    for (const tool of OVERSEER_MUTATING_TOOLS) {
      this.mutatingByName.set(tool.name, tool);
    }
  }

  statusTools(): readonly OverseerStatusTool[] {
    return OVERSEER_STATUS_TOOLS;
  }

  mutatingTools(): readonly OverseerMutatingTool[] {
    return OVERSEER_MUTATING_TOOLS;
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
      throw new OverseerToolError(`invalid input for ${tool.name}: ${detail}`);
    }
    return result.data;
  }

  /** Runs a read-only tool and returns its data. */
  callStatusTool(name: string, raw: unknown = {}): unknown {
    const tool = this.statusByName.get(name);
    if (tool === undefined) {
      throw new OverseerToolError(`unknown status tool: ${name}`);
    }
    return tool.read(this.ctx, this.parse(tool, raw));
  }

  /**
   * Validates a mutating tool call and records it as pending. Performs no part
   * of the effect — see applyAction.
   */
  callMutatingTool(name: string, raw: unknown = {}): OverseerAction {
    const tool = this.mutatingByName.get(name);
    if (tool === undefined) {
      throw new OverseerToolError(`unknown mutating tool: ${name}`);
    }
    const parsed = this.parse(tool, raw);
    const input = tool.pin?.(this.ctx, parsed) ?? parsed;
    // Throws on a target that doesn't exist or isn't in a state this tool can
    // act on, so the overseer finds out while it can still say something useful
    // — rather than the human confirming an action that was never going to work.
    const summary = tool.describe(this.ctx, input);
    const action: OverseerAction = {
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

  getAction(id: string): OverseerAction | undefined {
    return this.actions.get(id);
  }

  /** Every action still awaiting a decision, oldest first. */
  listPending(): OverseerAction[] {
    return [...this.actions.values()].filter((a) => a.status === 'pending');
  }

  /**
   * Performs a confirmed action's real effect, as `meta.actor`, the human who
   * confirmed it. The one path in this module that mutates anything.
   *
   * An action can only be applied once: a second call finds it no longer
   * `pending` and refuses, so a double-confirm (two clicks, a retried request)
   * can't dispatch two runs or cancel a run twice.
   */
  async applyAction(id: string, meta: ConfirmedBy): Promise<OverseerAction> {
    const action = this.requirePending(id, 'apply');
    const tool = this.mutatingByName.get(action.tool);
    // Only reachable if the tool list changed under a still-pending action.
    if (tool === undefined) {
      throw new OverseerToolError(`unknown mutating tool: ${action.tool}`);
    }
    // Claimed BEFORE the await, not after. requirePending alone only stops a
    // SEQUENTIAL second apply: with the flip after the await, two calls racing
    // each other both pass the check and both run — which is precisely the
    // double-click this guard exists to stop.
    action.status = 'applied';
    try {
      await tool.apply(this.ctx, action.input, meta);
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
  denyAction(id: string): OverseerAction {
    const action = this.requirePending(id, 'deny');
    action.status = 'denied';
    return action;
  }

  private requirePending(id: string, verb: string): OverseerAction {
    const action = this.actions.get(id);
    if (action === undefined) {
      throw new OverseerToolError(`unknown action: ${id}`);
    }
    if (action.status !== 'pending') {
      throw new OverseerToolError(
        `cannot ${verb} an action that is already ${action.status}: ${id}`
      );
    }
    return action;
  }
}
