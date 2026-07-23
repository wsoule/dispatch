import {
  ASSIGNEES,
  ConfigError,
  KINDS,
  loadConfig,
  PRIORITIES,
  TaskParseError,
  TaskStore,
} from '@dispatch/core';
import type { CreateInput, DispatchConfig, UpdatePatch } from '@dispatch/core';

import type { TaskCache } from './cache.js';
import type { EventBus } from './events.js';
import type { NoteKind } from './notes.js';
import { NOTE_KINDS, type NoteStore } from './notes.js';
import type { EpicEngine } from './orchestrator/epic.js';
import type { MergeQueue } from './orchestrator/mergeQueue.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { PlanManager } from './orchestrator/plan.js';
import type { PrManager } from './orchestrator/pr.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './orchestrator/types.js';

// Everything a request handler needs, bundled so `handleApi` stays a pure
// function of (request, context) instead of reaching for module-level state —
// this is what makes it easy to hit with plain fetch() in tests.
export interface ApiContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  version: string;
  // Phase 5 P1.
  planManager: PlanManager;
  epicEngine: EpicEngine;
  prManager: PrManager;
  mergeQueue: MergeQueue;
  noteStore: NoteStore;
  // Cached once at boot (see pr.ts's detectPrCapability) — exposed at
  // GET /api/health as `pr` so a client can hide/disable the PR action
  // without probing per-run.
  prCapability: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

// Mirrors the CLI's own enum check (packages/cli/src/commands/task.ts
// `validate`), including its exact message shape, without importing across
// the cli/server package boundary — cli is the one that depends on server
// for `dispatch serve`, not the other way around, and this check is small
// enough that duplicating it beats introducing a dependency edge for it.
// Used for status (against the project's configured list), kind, priority,
// and assignee (against core's fixed enums) — `undefined` means the field
// was omitted, which every caller here treats as "no change requested."
function validateEnumField(
  value: unknown,
  allowed: readonly string[],
  label: string
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `invalid ${label}: ${String(value)} (expected ${allowed.join('|')})`;
  }
  return null;
}

// Validates that an optional field, if present, is an array of strings —
// used for `labels` and `blockedBy`, both of which core's TaskParseError
// would otherwise only catch after the bad value had already been written to
// a task file (see taskfile.ts's matching `invalid ${key}: expected a list of
// strings`, which this mirrors).
function validateStringArrayField(
  value: unknown,
  label: string
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return `invalid ${label}: expected a list of strings`;
  }
  return null;
}

// Validates that an optional field, if present, is a string — used for the
// free-text body sections (description, acceptanceCriteria) that flow through
// to the markdown body rather than the frontmatter.
function validateStringField(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    return `invalid ${label}: expected a string`;
  }
  return null;
}

// Validates every field createTask/updateTask accept beyond title, entirely
// before either one touches the store — a request that fails here writes no
// file. `includeKind` is create-only: UpdatePatch has no `kind` field, since
// a task's kind is fixed at creation.
function validateTaskFields(
  value: Record<string, unknown>,
  config: DispatchConfig,
  { includeKind }: { includeKind: boolean }
): string | null {
  if (includeKind) {
    const kindError = validateEnumField(value.kind, KINDS, 'kind');
    if (kindError) return kindError;
  }
  const statusError = validateEnumField(
    value.status,
    config.statuses,
    'status'
  );
  if (statusError) return statusError;
  const priorityError = validateEnumField(
    value.priority,
    PRIORITIES,
    'priority'
  );
  if (priorityError) return priorityError;
  const assigneeError = validateEnumField(
    value.assignee,
    ASSIGNEES,
    'assignee'
  );
  if (assigneeError) return assigneeError;
  const labelsError = validateStringArrayField(value.labels, 'labels');
  if (labelsError) return labelsError;
  const blockedByError = validateStringArrayField(value.blockedBy, 'blockedBy');
  if (blockedByError) return blockedByError;
  // Free-text body sections — validated as optional strings before they reach
  // setSection, which would otherwise `.trim()` a non-string and throw.
  const descriptionError = validateStringField(
    value.description,
    'description'
  );
  if (descriptionError) return descriptionError;
  const acceptanceError = validateStringField(
    value.acceptanceCriteria,
    'acceptanceCriteria'
  );
  if (acceptanceError) return acceptanceError;
  return null;
}

async function readJsonBody(
  req: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    const value = await req.json();
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid body: expected a JSON object'),
      };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
}

// Same contract as readJsonBody, but an empty request body is treated as `{}`
// rather than a 400 — used for endpoints where every field is optional (only
// POST /api/tasks/:id/runs today: `executor` defaults when omitted), so a
// client that sends no body at all isn't penalized for it.
async function readJsonBodyOptional(
  req: Request
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const text = await req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid body: expected a JSON object'),
      };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
}

async function createTask(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const input = parsed.value as CreateInput;
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  const config = loadConfig(ctx.rootDir);
  const fieldsError = validateTaskFields(
    parsed.value as Record<string, unknown>,
    config,
    { includeKind: true }
  );
  if (fieldsError) return errorResponse(400, fieldsError);

  const doc = ctx.store.create(input);
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  return jsonResponse(doc, 201);
}

async function updateTask(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  if (ctx.store.get(id) === null) {
    return errorResponse(404, `task not found: ${id}`);
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.value as UpdatePatch;
  const config = loadConfig(ctx.rootDir);
  const fieldsError = validateTaskFields(
    parsed.value as Record<string, unknown>,
    config,
    { includeKind: false }
  );
  if (fieldsError) return errorResponse(400, fieldsError);

  const doc = ctx.store.update(id, patch);
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  return jsonResponse(doc);
}

// POST /api/tasks/:id/runs — dispatches a new orchestrator run for the task.
// `executor` is optional (defaults to 'claude'); a name outside what's
// actually registered on this Orchestrator instance (M6: derived live via
// `registeredExecutorNames()`, not a separately hardcoded list) is a 400
// here.
async function createRun(
  req: Request,
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const executorField = parsed.value.executor;
  const knownExecutorNames = ctx.orchestrator.registeredExecutorNames();
  if (
    executorField !== undefined &&
    (typeof executorField !== 'string' ||
      !knownExecutorNames.includes(executorField))
  ) {
    return errorResponse(
      400,
      `invalid executor: ${String(executorField)} (expected ${knownExecutorNames.join('|')})`
    );
  }

  // M1: a task that's already closed out (done/cancelled) is almost
  // certainly a stale UI action, not a genuine request to redo the work —
  // refuse it outright rather than quietly starting a new run against a
  // task nobody expects to still be moving. `null` (task not found) falls
  // through to orchestrator.dispatch()'s own 404 below.
  const task = ctx.store.get(taskId);
  if (
    task !== null &&
    (task.meta.status === 'done' || task.meta.status === 'cancelled')
  ) {
    return errorResponse(409, `cannot dispatch a ${task.meta.status} task`);
  }

  const modelField = parsed.value.model;
  if (modelField !== undefined && typeof modelField !== 'string') {
    return errorResponse(400, 'invalid model: expected a string');
  }

  const executorName =
    typeof executorField === 'string' ? executorField : 'claude';
  const meta = ctx.orchestrator.dispatch(taskId, executorName, {
    model: modelField,
  });
  return jsonResponse(meta, 201);
}

async function approveRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { requestId?: unknown; allow?: unknown };
  if (typeof body.requestId !== 'string' || body.requestId.trim() === '') {
    return errorResponse(400, 'invalid requestId: requestId is required');
  }
  if (typeof body.allow !== 'boolean') {
    return errorResponse(400, 'invalid allow: expected a boolean');
  }
  ctx.orchestrator.approve(runId, body.requestId, body.allow);
  return jsonResponse({ ok: true });
}

async function sendRunMessage(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown; resume?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  if (body.resume !== undefined && typeof body.resume !== 'boolean') {
    return errorResponse(400, 'invalid resume: expected a boolean');
  }
  const meta = ctx.orchestrator.sendMessage(runId, body.text, {
    resume: body.resume === true,
  });
  return jsonResponse(meta);
}

// Phase 5 P1: `action: 'pr'` is routed to PrManager.openPr rather than
// Orchestrator.review — pushing a branch and opening a GitHub PR is a
// different kind of "review" than the local merge/discard actions
// Orchestrator itself owns, and keeping it in its own module is what lets
// tests inject a stubbed gh/git CommandRunner (see pr.ts) without pulling
// that seam into Orchestrator's own constructor.
async function reviewRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { action?: unknown };
  if (
    typeof body.action !== 'string' ||
    (body.action !== 'merge' &&
      body.action !== 'discard' &&
      body.action !== 'pr')
  ) {
    return errorResponse(
      400,
      `invalid action: ${String(body.action)} (expected merge|discard|pr)`
    );
  }
  if (body.action === 'pr') {
    const meta = await ctx.prManager.openPr(runId);
    return jsonResponse(meta);
  }
  const meta = ctx.orchestrator.review(runId, body.action);
  return jsonResponse(meta);
}

// GET /api/runs/:id/pr — the run's GitHub PR status + conversation, read live
// via gh (see PrManager.getPrDetail). 409s a run with no open PR.
async function getPr(
  _req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const detail = await ctx.prManager.getPrDetail(runId);
  return jsonResponse(detail);
}

// POST /api/runs/:id/pr/review — submit a GitHub review on the run's PR.
// `approve` may omit a body; `request-changes` and `comment` require one, the
// same rule gh itself enforces.
async function reviewPr(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { event?: unknown; body?: unknown };
  if (
    body.event !== 'approve' &&
    body.event !== 'request-changes' &&
    body.event !== 'comment'
  ) {
    return errorResponse(
      400,
      `invalid event: ${String(body.event)} (expected approve|request-changes|comment)`
    );
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if (body.event !== 'approve' && text.trim() === '') {
    return errorResponse(400, `a ${body.event} review requires a body`);
  }
  const detail = await ctx.prManager.reviewPr(runId, body.event, text);
  return jsonResponse(detail);
}

// POST /api/runs/:id/pr/comment — add a PR-level comment (not a review).
async function commentPr(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'invalid body: body is required');
  }
  const detail = await ctx.prManager.commentPr(runId, body.body);
  return jsonResponse(detail);
}

// `fromRunId` is optional and identifies the SENDER (a different run than
// `runId`, the recipient) — the MCP `agent_message` tool passes its own
// `DISPATCH_RUN_ID` here so Orchestrator.inject can resolve a real sender
// label (task title + id) instead of falling back to the generic "another
// agent". A `fromRunId` that doesn't resolve to a known run is not an
// error here — inject()'s own resolveSenderLabel already tolerates an
// unresolvable sender by falling back to the generic label, so this route
// just passes the raw value through rather than pre-validating it.
async function injectRunMessage(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown; fromRunId?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  if (body.fromRunId !== undefined && typeof body.fromRunId !== 'string') {
    return errorResponse(400, 'invalid fromRunId: expected a string');
  }
  const meta = ctx.orchestrator.inject(
    runId,
    body.text,
    body.fromRunId !== undefined ? { runId: body.fromRunId } : undefined
  );
  return jsonResponse(meta);
}

// POST /api/runs/:id/message-user — the agent→human channel (spec's
// `message_user`): records a `from: 'agent'` message entry on the AGENT'S
// OWN run, using that run's own task title + id as the label, so the human
// sees "this agent flagged something" in the exact same Session tab as
// everything else that run has said. Unlike `inject`, this never sends
// anything back into the executor (there is no "recipient" to deliver
// to) — it only needs the run to still be live so appending to its
// transcript/broadcasting means something to a connected client, the same
// liveness bar `inject` itself already enforces.
async function messageUser(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const meta = ctx.orchestrator.messageUser(runId, body.text);
  return jsonResponse(meta);
}

// POST /api/plan. `planner` is optional (defaults to 'claude'), same
// contract as createRun's `executor` field above: a name outside what's
// actually registered on this PlanManager instance (Phase 7's
// registerPlanner/registeredPlannerNames, mirroring the orchestrator's own
// executor registry) is a 400 naming every valid option.
async function startPlan(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { prompt?: unknown; planner?: unknown };
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    return errorResponse(400, 'invalid prompt: prompt is required');
  }
  const knownPlannerNames = ctx.planManager.registeredPlannerNames();
  if (
    body.planner !== undefined &&
    (typeof body.planner !== 'string' ||
      !knownPlannerNames.includes(body.planner))
  ) {
    return errorResponse(
      400,
      `invalid planner: ${String(body.planner)} (expected ${knownPlannerNames.join('|')})`
    );
  }
  const plannerName =
    typeof body.planner === 'string' ? body.planner : 'claude';
  const record = ctx.planManager.startPlan(body.prompt, plannerName);
  return jsonResponse({ planId: record.id }, 202);
}

async function confirmPlan(
  req: Request,
  ctx: ApiContext,
  planId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { proposal?: unknown };
  const result = ctx.planManager.confirm(planId, body.proposal);
  return jsonResponse(result);
}

async function startEpic(
  req: Request,
  ctx: ApiContext,
  epicId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { concurrency?: unknown; executor?: unknown };
  if (body.concurrency !== undefined && typeof body.concurrency !== 'number') {
    return errorResponse(400, 'invalid concurrency: expected a number');
  }
  if (body.executor !== undefined && typeof body.executor !== 'string') {
    return errorResponse(400, 'invalid executor: expected a string');
  }
  const session = ctx.epicEngine.start(epicId, {
    concurrency: body.concurrency,
    executor: body.executor,
  });
  return jsonResponse(session, 201);
}

// POST /api/merge-queue { runId }. Enqueues a finished, unreviewed run for
// the serial rebase -> verify -> merge pipeline. 404/409 map straight from
// MergeQueue.enqueue's typed errors via the shared handler below.
async function enqueueMergeQueue(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { runId?: unknown };
  if (typeof body.runId !== 'string' || body.runId.trim() === '') {
    return errorResponse(400, 'invalid runId: runId is required');
  }
  const entry = ctx.mergeQueue.enqueue(body.runId);
  return jsonResponse(entry, 201);
}

// Routes every `/api/*` request. Called only for paths under `/api` — the
// caller (index.ts) handles `/ws` upgrades and static file serving itself.
// POST /api/notes — create a note/triage/follow-up/todo. Used by the app's
// Notes tab and (via the MCP `dispatch_note` tool) by agents flagging triage
// they find mid-run. `createdByRunId` optionally records which agent added it.
async function createNote(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    kind?: unknown;
    title?: unknown;
    body?: unknown;
    createdByRunId?: unknown;
  };
  if (
    typeof body.kind !== 'string' ||
    !NOTE_KINDS.includes(body.kind as NoteKind)
  ) {
    return errorResponse(
      400,
      `invalid kind: ${String(body.kind)} (expected ${NOTE_KINDS.join('|')})`
    );
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  const note = ctx.noteStore.create({
    kind: body.kind as NoteKind,
    title: body.title.trim(),
    body: typeof body.body === 'string' ? body.body : undefined,
    createdByRunId:
      typeof body.createdByRunId === 'string' ? body.createdByRunId : undefined,
  });
  ctx.events.broadcast({ type: 'note.changed' });
  return jsonResponse(note, 201);
}

// PATCH /api/notes/:id — edit a note or toggle its done flag.
async function updateNote(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    title?: unknown;
    body?: unknown;
    kind?: unknown;
    done?: unknown;
  };
  if (
    body.kind !== undefined &&
    (typeof body.kind !== 'string' ||
      !NOTE_KINDS.includes(body.kind as NoteKind))
  ) {
    return errorResponse(400, `invalid kind: ${String(body.kind)}`);
  }
  try {
    const note = ctx.noteStore.update(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      body: typeof body.body === 'string' ? body.body : undefined,
      kind: body.kind as NoteKind | undefined,
      done: typeof body.done === 'boolean' ? body.done : undefined,
    });
    ctx.events.broadcast({ type: 'note.changed' });
    return jsonResponse(note);
  } catch {
    return errorResponse(404, `note not found: ${id}`);
  }
}

// DELETE /api/notes/:id.
function deleteNote(ctx: ApiContext, id: string): Response {
  try {
    ctx.noteStore.delete(id);
    ctx.events.broadcast({ type: 'note.changed' });
    return jsonResponse({ ok: true });
  } catch {
    return errorResponse(404, `note not found: ${id}`);
  }
}

// POST /api/notes/:id/promote — turn a note into a real task (its title +
// body become the task's title + description), and link the note to the new
// task so the hub can show "promoted → t-xxxxxx" instead of offering it again.
function promoteNote(ctx: ApiContext, id: string): Response {
  const note = ctx.noteStore.get(id);
  if (note === null) return errorResponse(404, `note not found: ${id}`);
  if (note.linkedTaskId !== null) {
    return errorResponse(409, `note already promoted: ${note.linkedTaskId}`);
  }
  const task = ctx.store.create({
    title: note.title,
    description: note.body,
    // A triage an agent flagged is real work → default it to a task; everything
    // else (a follow-up/note/todo) becomes a task too, all in the backlog.
    kind: 'task',
  });
  ctx.noteStore.update(id, { linkedTaskId: task.meta.id, done: true });
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  ctx.events.broadcast({ type: 'note.changed' });
  return jsonResponse(task, 201);
}

export async function handleApi(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const method = req.method;

  try {
    if (segments[0] === 'health' && segments.length === 1 && method === 'GET') {
      // `rootDir` lets the web UI show a project name (its basename) in the
      // top bar without a separate endpoint — see the phase-2 plan's Slice
      // S3 TopBar requirement.
      return jsonResponse({
        ok: true,
        version: ctx.version,
        rootDir: ctx.rootDir,
        // Files the most recent cache rebuild couldn't parse (e.g. missing
        // frontmatter, invalid kind) — empty when the task set is clean. The
        // daemon keeps serving the last-good cache regardless; this is
        // visibility, not a fatal signal (`ok` stays true).
        problems: ctx.cache.problems(),
        // Phase 5 P1: whether this project can use the PR review action
        // (gh on PATH + a configured git remote), detected once at boot.
        pr: ctx.prCapability,
      });
    }

    if (segments[0] === 'config' && segments.length === 1 && method === 'GET') {
      return jsonResponse(loadConfig(ctx.rootDir));
    }

    if (segments[0] === 'tasks') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(
          ctx.cache.query({
            status: url.searchParams.get('status') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            parent: url.searchParams.get('parent') ?? undefined,
          })
        );
      }
      if (segments.length === 1 && method === 'POST') {
        return await createTask(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'ready' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.cache.ready());
      }
      if (segments.length === 2 && method === 'GET') {
        const doc = ctx.cache.get(segments[1]);
        return doc !== null
          ? jsonResponse(doc)
          : errorResponse(404, `task not found: ${segments[1]}`);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateTask(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'runs' &&
        method === 'POST'
      ) {
        return await createRun(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'runs') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.orchestrator.list());
      }
      if (segments.length === 2 && method === 'GET') {
        const result = ctx.orchestrator.getRun(segments[1]);
        return result !== null
          ? jsonResponse(result)
          : errorResponse(404, `run not found: ${segments[1]}`);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'approval' &&
        method === 'POST'
      ) {
        return await approveRun(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'message' &&
        method === 'POST'
      ) {
        return await sendRunMessage(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'cancel' &&
        method === 'POST'
      ) {
        await ctx.orchestrator.cancel(segments[1]);
        return jsonResponse({ ok: true });
      }
      if (segments.length === 3 && segments[2] === 'diff' && method === 'GET') {
        return jsonResponse(ctx.orchestrator.diff(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await reviewRun(req, ctx, segments[1]);
      }
      if (segments.length === 3 && segments[2] === 'pr' && method === 'GET') {
        return await getPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'pr' &&
        segments[3] === 'review' &&
        method === 'POST'
      ) {
        return await reviewPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'pr' &&
        segments[3] === 'comment' &&
        method === 'POST'
      ) {
        return await commentPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'inject' &&
        method === 'POST'
      ) {
        return await injectRunMessage(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'message-user' &&
        method === 'POST'
      ) {
        return await messageUser(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'notes') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.noteStore.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await createNote(req, ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateNote(req, ctx, segments[1]);
      }
      if (segments.length === 2 && method === 'DELETE') {
        return deleteNote(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'promote' &&
        method === 'POST'
      ) {
        return promoteNote(ctx, segments[1]);
      }
    }

    if (segments[0] === 'plan') {
      if (segments.length === 1 && method === 'POST') {
        return await startPlan(req, ctx);
      }
      if (segments.length === 2 && method === 'GET') {
        return jsonResponse(ctx.planManager.get(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'confirm' &&
        method === 'POST'
      ) {
        return await confirmPlan(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'epics') {
      if (
        segments.length === 3 &&
        segments[2] === 'dispatch' &&
        method === 'POST'
      ) {
        return await startEpic(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'stop' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.epicEngine.stop(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'progress' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.epicEngine.progress(segments[1]));
      }
    }

    if (segments[0] === 'merge-queue') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.mergeQueue.snapshot());
      }
      if (segments.length === 1 && method === 'POST') {
        return await enqueueMergeQueue(req, ctx);
      }
      if (segments.length === 2 && method === 'DELETE') {
        ctx.mergeQueue.remove(segments[1]);
        return new Response(null, { status: 204 });
      }
    }

    return errorResponse(404, `not found: ${url.pathname}`);
  } catch (err) {
    // TaskParseError (a corrupt task file) and ConfigError (corrupt
    // config.yml) are the only errors expected to reach here from core; both
    // map to 422 with just their message — never a stack trace. The
    // Orchestrator* errors mirror that same typed-error-to-status-code
    // pattern for the run endpoints.
    if (err instanceof TaskParseError || err instanceof ConfigError) {
      return errorResponse(422, err.message);
    }
    if (err instanceof OrchestratorNotFoundError) {
      return errorResponse(404, err.message);
    }
    if (err instanceof OrchestratorConflictError) {
      return errorResponse(409, err.message);
    }
    if (err instanceof OrchestratorClientError) {
      return errorResponse(400, err.message);
    }
    throw err;
  }
}
