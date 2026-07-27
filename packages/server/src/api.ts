import {
  ASSIGNEES,
  ConfigError,
  KINDS,
  loadConfig,
  PRIORITIES,
  TaskParseError,
  TaskStore,
  updateConfig,
} from '@dispatch/core';
import type {
  ConfigPatch,
  CreateInput,
  DispatchConfig,
  UpdatePatch,
} from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';

import type { TaskCache } from './cache.js';
import type { EventBus } from './events.js';
import type { InboxItem, InboxKind } from './inbox.js';
import { INBOX_KINDS, type InboxStore } from './inbox.js';
import { InboxClusterer } from './inboxClusterer.js';
import type { Note, NoteKind } from './notes.js';
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
import {
  formatCommentsForAgent,
  ReviewCommentStore,
} from './reviewComments.js';

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
  inboxStore: InboxStore;
  inboxClusterer?: InboxClusterer;
  reviewComments: ReviewCommentStore;
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

// Validates that an optional field, if present, is a boolean — used for
// `selfReview`, mirroring core's taskfile.ts `self-review` boolean check so a
// bad value is rejected here rather than only after it's already written.
function validateBooleanField(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    return `invalid ${label}: expected a boolean`;
  }
  return null;
}

// Validates that an optional field, if present, is a string or null — used
// for `archivedAt` (a string sets it, null clears it), rejecting bad values
// here rather than letting them corrupt the task's YAML frontmatter.
function validateStringOrNullField(
  value: unknown,
  label: string
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return `invalid ${label}: expected a string or null`;
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
  const selfReviewError = validateBooleanField(value.selfReview, 'selfReview');
  if (selfReviewError) return selfReviewError;
  const archivedAtError = validateStringOrNullField(
    value.archivedAt,
    'archivedAt'
  );
  if (archivedAtError) return archivedAtError;
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

// POST /api/tasks/draft — the natural-language single-task creator: turns a
// free-text description into one structured task draft (title, description,
// acceptanceCriteria, priority) the client reviews and then saves through the
// normal POST /api/tasks path. `planner` is optional and follows createRun's
// `executor` / startPlan's `planner` contract exactly — a name outside what's
// registered on this PlanManager is a 400 naming every valid option. Unlike
// startPlan this awaits the planner and returns the draft directly (no plan
// record, no confirm step) since a lone draft is reviewed-then-created, not
// confirmed.
async function draftTask(req: Request, ctx: ApiContext): Promise<Response> {
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
  const draft = await ctx.planManager.draftTask(body.prompt, plannerName);
  return jsonResponse(draft);
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
  const meta = await ctx.orchestrator.dispatch(taskId, executorName, {
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

/**
 * PATCH /api/config — change the settings a person is allowed to change.
 *
 * Deliberately a narrow allow-list rather than a general config write. `statuses` in particular
 * is structural: every task on disk carries one, so editing the list from a settings form would
 * orphan tasks whose status no longer exists. Anything not in ConfigPatch has to be edited in
 * the file, where the consequences are visible.
 */
async function patchConfig(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;

  const patch: ConfigPatch = {};
  if ('verifyCommand' in body) {
    const v = body.verifyCommand;
    if (v !== null && typeof v !== 'string') {
      return errorResponse(400, 'verifyCommand must be a string or null');
    }
    patch.verifyCommand = v;
  }
  if ('autoCommit' in body) {
    if (typeof body.autoCommit !== 'boolean') {
      return errorResponse(400, 'autoCommit must be a boolean');
    }
    patch.autoCommit = body.autoCommit;
  }
  for (const key of ['epicConcurrency', 'verifyTimeoutSec'] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'number') {
      return errorResponse(400, `${key} must be a number`);
    }
    patch[key] = body[key];
  }
  if ('permissionMode' in body) {
    if (typeof body.permissionMode !== 'string') {
      return errorResponse(400, 'permissionMode must be a string');
    }
    // The valid set lives in core, next to the parser that enforces it — duplicating it here
    // would be a second list to keep in step. updateConfig rejects an unknown one before it
    // writes anything, and that ConfigError becomes the 400 below.
    patch.permissionMode = body.permissionMode;
  }

  try {
    const config = updateConfig(ctx.rootDir, patch);
    ctx.events.broadcast({ type: 'config.changed' });
    return jsonResponse(config);
  } catch (err) {
    return errorResponse(400, (err as Error).message);
  }
}

// GET /api/runs/:id/comments — every review comment on this run's diff.
function listReviewComments(ctx: ApiContext, runId: string): Response {
  return jsonResponse(ctx.reviewComments.list(runId));
}

/**
 * POST /api/runs/:id/comments — leave a line-level note on the diff.
 *
 * `anchorText` is required and is the whole point: it records what the line said when the
 * comment was written, which is the only way to tell later whether the comment still points at
 * the code it was about. Without it a comment silently drifts onto unrelated lines as the agent
 * pushes commits.
 */
async function addReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    file?: unknown;
    line?: unknown;
    anchorText?: unknown;
    body?: unknown;
  };
  if (typeof body.file !== 'string' || body.file === '') {
    return errorResponse(400, 'file is required');
  }
  if (typeof body.line !== 'number' || !Number.isInteger(body.line)) {
    return errorResponse(400, 'line must be an integer');
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  const comment = ctx.reviewComments.add(runId, {
    file: body.file,
    line: body.line,
    anchorText: typeof body.anchorText === 'string' ? body.anchorText : '',
    body: body.body.trim(),
  });
  ctx.events.broadcast({ type: 'review.changed', runId });
  return jsonResponse(comment, 201);
}

// PATCH /api/runs/:id/comments/:commentId — resolve or unresolve a thread.
async function updateReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string,
  commentId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { resolved?: unknown };
  if (typeof body.resolved !== 'boolean') {
    return errorResponse(400, 'resolved must be a boolean');
  }
  try {
    const comment = ctx.reviewComments.setResolved(
      runId,
      commentId,
      body.resolved
    );
    ctx.events.broadcast({ type: 'review.changed', runId });
    return jsonResponse(comment);
  } catch (err) {
    return errorResponse(404, (err as Error).message);
  }
}

// POST /api/runs/:id/comments/:commentId/reply — add to a thread.
async function replyReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string,
  commentId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  try {
    const comment = ctx.reviewComments.reply(
      runId,
      commentId,
      body.body.trim()
    );
    ctx.events.broadcast({ type: 'review.changed', runId });
    return jsonResponse(comment);
  } catch (err) {
    return errorResponse(404, (err as Error).message);
  }
}

/**
 * POST /api/runs/:id/send-back — return the work to the agent with the review attached.
 *
 * This is where the review UI's promise gets kept: the unresolved threads are rendered into the
 * message the agent resumes on, so "the agent reads this when you send the work back" is
 * literally true rather than decorative. A free-text note is optional and leads, since it is the
 * reviewer's framing; the threads follow as specifics.
 *
 * Refuses an empty review outright. Resuming an agent with no instruction burns a run to be told
 * nothing, which is worse than making the user say what they want.
 */
async function sendBackRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { note?: unknown };
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const threads = formatCommentsForAgent(ctx.reviewComments.list(runId));

  if (note === '' && threads === '') {
    return errorResponse(
      400,
      'nothing to send back — leave a note or an unresolved comment first'
    );
  }
  const message = [note, threads].filter((part) => part !== '').join('\n\n');
  try {
    const meta = ctx.orchestrator.sendMessage(runId, message);
    return jsonResponse(meta);
  } catch (err) {
    return errorResponse(409, (err as Error).message);
  }
}

// POST /api/branches/free-disk — reclaims a branch's worktree directory while
// leaving its branch ref intact, so the work stays recoverable. Returns the
// branch's refreshed BranchEntry rather than a bare 204 so the client can
// re-render one row without re-fetching the whole list.
async function freeBranchDisk(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { branch?: unknown };
  if (typeof body.branch !== 'string' || body.branch === '') {
    return errorResponse(400, 'branch is required');
  }
  return jsonResponse(ctx.orchestrator.freeWorktreeDisk(body.branch));
}

// DELETE /api/branches/:branch — removes a branch ref and any worktree it
// still has. The branch name is URL-encoded by the client because dispatch
// branch names always contain `/`, so the whole remainder of the path after
// `branches/` is rejoined and decoded rather than read as a single segment.
// `?force=1` opts into deleting a branch whose commits have NOT landed on its
// base — the one irreversible case, which the orchestrator refuses otherwise.
function deleteBranch(ctx: ApiContext, branch: string, url: URL): Response {
  const force = url.searchParams.get('force') === '1';
  ctx.orchestrator.deleteBranch(branch, { force });
  return jsonResponse({ ok: true });
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

// Resolves a PR number to its RepoPr entry via listRepoPrs() — shared by the
// three /api/prs/:number/* handlers below. Returns `null` (caller 404s) when
// the number isn't among the repo's currently-open PRs, so this can never be
// used to review/comment on an arbitrary PR url a client supplies directly;
// listRepoPrs() itself is what 409s when the project lacks pr capability.
async function resolveRepoPrByNumber(
  ctx: ApiContext,
  numberParam: string
): Promise<{ number: number; url: string; title: string } | null> {
  const number = Number(numberParam);
  const prs = await ctx.prManager.listRepoPrs();
  const pr = prs.find((p) => p.number === number);
  return pr ?? null;
}

// GET /api/prs/:number/detail — the in-app detail view for a repo PR
// dispatch never opened itself ("Other open PRs"). Mirrors GET
// /api/runs/:id/pr, but keyed by PR number instead of a run id.
async function getRepoPrDetail(
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const detail = await ctx.prManager.getPrDetailByUrl(pr.url, pr.title);
  return jsonResponse(detail);
}

// POST /api/prs/:number/review — submit a GitHub review on a repo PR by
// number. Body validation mirrors POST /api/runs/:id/pr/review exactly.
async function reviewRepoPr(
  req: Request,
  ctx: ApiContext,
  numberParam: string
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
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const detail = await ctx.prManager.reviewPrByUrl(pr.url, body.event, text);
  return jsonResponse(detail);
}

// POST /api/prs/:number/comment — add a PR-level comment on a repo PR by
// number. Body validation mirrors POST /api/runs/:id/pr/comment exactly.
async function commentRepoPr(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'invalid body: body is required');
  }
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const detail = await ctx.prManager.commentPrByUrl(pr.url, body.body);
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

// POST /api/plan/:id/message — send a follow-up user message on an existing
// plan conversation. Returns 202 with the record already flipped back to
// `running`; the assistant's reply + refined proposal land asynchronously via
// the same `plan.changed` broadcast startPlan uses. 404s an unknown plan, and
// 409s a plan mid-turn or already confirmed (both raised by sendMessage).
async function sendPlanMessage(
  req: Request,
  ctx: ApiContext,
  planId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const record = ctx.planManager.sendMessage(planId, body.text);
  return jsonResponse(record, 202);
}

async function confirmPlan(
  req: Request,
  ctx: ApiContext,
  planId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { proposal?: unknown };
  // Read the record before confirming: a plan started from a note (POST
  // /api/notes/:id/enrich) carries that note's id, and once confirm has
  // written the task the note has to be linked and closed out exactly the way
  // the plain promote path does — otherwise the hub would keep offering to
  // promote a note whose task already exists.
  const sourceNoteId = ctx.planManager.get(planId).sourceNoteId;
  const result = ctx.planManager.confirm(planId, body.proposal);
  if (sourceNoteId !== undefined && result.taskIds.length > 0) {
    linkNoteToTask(ctx, sourceNoteId, result.taskIds[0]);
  }
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
  const session = await ctx.epicEngine.start(epicId, {
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

// POST /api/merge-queue/stack { taskId }. Enqueues every reviewable run
// across `taskId`'s stack (its blockedBy-connected component) in dependency
// order — see MergeQueue.enqueueStack's own comment for why that order lets
// the queue's existing waiting-blockers gating serialize the stack for free.
// 409 only when every member of the stack was skipped (nothing reviewable),
// mapped through the same OrchestratorConflictError -> 409 path as every
// other merge-queue action, below.
async function enqueueMergeQueueStack(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { taskId?: unknown };
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    return errorResponse(400, 'invalid taskId: taskId is required');
  }
  const entries = ctx.mergeQueue.enqueueStack(body.taskId);
  return jsonResponse(entries, 201);
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

// Marks a note as promoted: points it at the task that now carries its work
// and ticks it done, so the hub shows "→ t-xxxxxx" instead of offering to
// promote it again. Shared by the plain promote path and the AI-drafted one
// (confirmPlan), which reach this point at different times — hence the
// tolerance for the note having been deleted while its plan was in flight:
// the task stands on its own, there is just nothing left to link back to.
function linkNoteToTask(ctx: ApiContext, noteId: string, taskId: string): void {
  try {
    ctx.noteStore.update(noteId, { linkedTaskId: taskId, done: true });
  } catch {
    return;
  }
  ctx.events.broadcast({ type: 'note.changed' });
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
  // Cache first, link second: the note's `note.changed` broadcast is what
  // makes the hub render "→ t-xxxxxx", and that id has to already resolve in
  // the task cache by the time a client follows it.
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  linkNoteToTask(ctx, id, task.meta.id);
  return jsonResponse(task, 201);
}

// POST /api/inbox — capture raw text. The body's `text` is split server-side into one item
// per non-empty line, so the splitting rule lives in exactly one place rather than being
// reimplemented by every client (the desktop composer, the MCP tool, a future CLI).
async function addInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    text?: unknown;
    kind?: unknown;
    createdByRunId?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') return errorResponse(400, 'text is required');

  let kind: InboxKind | undefined;
  if (typeof body.kind === 'string') {
    if (!(INBOX_KINDS as readonly string[]).includes(body.kind)) {
      return errorResponse(400, `unknown inbox kind: ${body.kind}`);
    }
    kind = body.kind as InboxKind;
  }

  const created = ctx.inboxStore.add({
    text,
    kind,
    createdByRunId:
      typeof body.createdByRunId === 'string' ? body.createdByRunId : null,
  });
  ctx.events.broadcast({ type: 'inbox.changed' });
  return jsonResponse(created, 201);
}

// PATCH /api/inbox/:id — retype an item, fix its wording, or toggle it done.
async function updateInbox(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    kind?: unknown;
    text?: unknown;
    done?: unknown;
  };
  if (
    typeof body.kind === 'string' &&
    !(INBOX_KINDS as readonly string[]).includes(body.kind)
  ) {
    return errorResponse(400, `unknown inbox kind: ${body.kind}`);
  }
  try {
    const item = ctx.inboxStore.update(id, {
      kind:
        typeof body.kind === 'string' ? (body.kind as InboxKind) : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      done: typeof body.done === 'boolean' ? body.done : undefined,
    });
    ctx.events.broadcast({ type: 'inbox.changed' });
    return jsonResponse(item);
  } catch (err) {
    return errorResponse(404, (err as Error).message);
  }
}

// POST /api/inbox/dismiss — drop items outright. A dismissed thought should not linger in an
// archive; the point of the inbox is that most of what lands in it is noise.
async function dismissInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return errorResponse(400, 'ids is required');
  ctx.inboxStore.remove(ids);
  ctx.events.broadcast({ type: 'inbox.changed' });
  return jsonResponse({ dismissed: ids.length });
}

/**
 * POST /api/inbox/convert — turn inbox items into real tasks.
 *
 * Spans two stores, so partial failure is a real outcome and is reported rather than swallowed:
 * the response carries a per-item result, and a caller that asked for five conversions and got
 * three has to be able to see which two did not land. Tasks are created first and the inbox is
 * linked afterwards, so an interrupted convert leaves an unlinked task (visible, recoverable)
 * rather than an inbox item pointing at a task that was never written.
 */
async function convertInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return errorResponse(400, 'ids is required');

  const items = new Map(ctx.inboxStore.list().map((i) => [i.id, i]));
  const results: {
    id: string;
    taskId?: string;
    error?: string;
  }[] = [];
  const links: { id: string; taskId: string }[] = [];

  for (const id of ids) {
    const item = items.get(id);
    if (item === undefined) {
      results.push({ id, error: `inbox item not found: ${id}` });
      continue;
    }
    if (item.linkedTaskId !== null) {
      // Already converted — report the existing task rather than making a second one.
      results.push({ id, taskId: item.linkedTaskId });
      continue;
    }
    try {
      const task = ctx.store.create({ title: item.text, kind: 'task' });
      links.push({ id, taskId: task.meta.id });
      results.push({ id, taskId: task.meta.id });
    } catch (err) {
      results.push({ id, error: (err as Error).message });
    }
  }

  if (links.length > 0) {
    // Cache first so the ids in the response already resolve for a client that follows them.
    ctx.cache.rebuild(ctx.store);
    ctx.events.broadcast({ type: 'task.changed' });
    ctx.inboxStore.markConverted(links);
    ctx.events.broadcast({ type: 'inbox.changed' });
  }

  const failed = results.filter((r) => r.error !== undefined).length;
  return jsonResponse({ results, converted: links.length, failed });
}

// The planning prompt behind "draft with AI": what a note is missing is
// context — which files it touches, what the code does today, what "done"
// means — so this asks the planner to go read the repo and spend that
// research on ONE task that keeps the note's original intent, rather than the
// epic-plus-breakdown a free-form plan prompt invites. The surrounding
// planner wrapper (planners/claude.ts) supplies the read-only framing and the
// output schema; this only supplies the request.
function buildNoteEnrichPrompt(note: Note): string {
  const kindLabel = note.kind === 'followup' ? 'follow-up' : note.kind;
  return [
    `Someone captured this one-line ${kindLabel} in a task tracker and wants ` +
      'it turned into a properly specified task before an agent picks it up.',
    `Title: ${note.title}`,
    note.body.trim() === '' ? null : `Notes: ${note.body.trim()}`,
    'Read enough of this repository to ground it: which files and functions ' +
      'are actually involved, what the code does today, and what would have ' +
      'to change. Then propose exactly ONE task, and no epic. Keep the ' +
      "original intent — sharpen the title, don't replace the request — and " +
      'write a description that gives an implementing agent the context this ' +
      'one-liner is missing, naming concrete paths where you found them. ' +
      'Acceptance criteria should be checkable statements about the finished ' +
      'work. Do not invent scope the note never asked for; if the repo ' +
      'contradicts the note, say so in the description rather than silently ' +
      'redesigning the work.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

/**
 * The prompt behind "add detail" on an inbox item.
 *
 * Same shape as the note version, and for the same reason: what a one-line capture is missing is
 * context — which files it touches, what the code does today, what "done" means. Only the framing
 * differs, because an inbox item is a raw thought rather than a filed note.
 */
function buildInboxEnrichPrompt(item: InboxItem): string {
  return [
    `Someone dumped this one-line ${item.kind} into a capture inbox and wants it turned into a ` +
      'properly specified task before an agent picks it up.',
    `Captured: ${item.text}`,
    'Read enough of this repository to ground it: which files and functions are actually ' +
      'involved, what the code does today, and what would have to change. Then propose exactly ' +
      "ONE task, and no epic. Keep the original intent — sharpen it, don't replace it — and " +
      'write a description that gives an implementing agent the context this one-liner is ' +
      'missing, naming concrete paths where you found them. Acceptance criteria should be ' +
      'checkable statements about the finished work. Do not invent scope the capture never ' +
      'asked for; if the repo contradicts it, say so in the description rather than silently ' +
      'redesigning the work.',
  ].join('\n\n');
}

/**
 * POST /api/inbox/cluster — ask a model which captured items are really one piece of work.
 *
 * Explicitly user-triggered rather than automatic, because unlike the desktop's local heuristic
 * this costs a model call: a suggestion that quietly bills you on every render is not a
 * suggestion. Failures return 502 with the reason rather than an empty list, so "the model is
 * unreachable" never reads as "nothing here is related".
 */
async function clusterInbox(ctx: ApiContext): Promise<Response> {
  const clusterer = ctx.inboxClusterer ?? new InboxClusterer(ctx.rootDir);
  try {
    const groups = await clusterer.cluster(ctx.inboxStore.list());
    return jsonResponse({ groups });
  } catch (err) {
    return errorResponse(502, (err as Error).message);
  }
}

// POST /api/inbox/:id/enrich — AI-draft the task this captured line should become. Same async
// contract as POST /api/plan: returns a planId immediately, the client polls
// GET /api/plan/:id and writes nothing until POST /api/plan/:id/confirm.
function enrichInbox(ctx: ApiContext, id: string): Response {
  const item = ctx.inboxStore.list().find((i) => i.id === id);
  if (item === undefined)
    return errorResponse(404, `inbox item not found: ${id}`);
  if (item.linkedTaskId !== null) {
    return errorResponse(409, `already converted: ${item.linkedTaskId}`);
  }
  const record = ctx.planManager.startPlan(
    buildInboxEnrichPrompt(item),
    'claude',
    item.id
  );
  return jsonResponse({ planId: record.id }, 202);
}

/**
 * The prompt behind "add detail" on a task that already exists.
 *
 * Different job from the two above, and the difference matters: those turn a one-liner INTO a
 * task, while this one deepens a task that is already real and may already have been partly
 * specified by a human. So it is told explicitly to preserve what is there and add to it — the
 * failure mode to avoid is an agent helpfully rewriting a carefully-worded acceptance criterion
 * into something vaguer.
 */
function buildTaskEnrichPrompt(task: TaskDoc, body: string): string {
  const existing = body.trim();
  return [
    'A task in this repository is under-specified, and someone wants it fleshed out before an ' +
      'agent picks it up.',
    `Title: ${task.meta.title}`,
    existing === ''
      ? 'It currently has no description at all.'
      : `Its current description and criteria:\n\n${existing}`,
    'Read enough of this repository to ground it: which files and functions are actually ' +
      'involved, what the code does today, and what would have to change. Then propose exactly ' +
      "ONE task, and no epic, keeping this task's title and intent. " +
      'PRESERVE everything already written that is still correct — you are adding the context ' +
      "this task is missing, not rewriting someone else's specification. Name concrete paths " +
      'where you found them. Acceptance criteria should be checkable statements about the ' +
      'finished work; keep any that already exist and add the ones that are missing. If the repo ' +
      'contradicts what the task says, say so in the description rather than silently ' +
      'redesigning the work.',
  ].join('\n\n');
}

// POST /api/tasks/:id/enrich — AI-draft a fuller description for an existing task. Returns a
// planId; nothing is written until the client confirms the proposal.
function enrichTask(ctx: ApiContext, id: string): Response {
  const task = ctx.cache.get(id);
  if (task === null || task === undefined) {
    return errorResponse(404, `task not found: ${id}`);
  }
  const record = ctx.planManager.startPlan(
    buildTaskEnrichPrompt(task, task.body ?? ''),
    'claude',
    task.meta.id
  );
  return jsonResponse({ planId: record.id }, 202);
}

// POST /api/notes/:id/enrich — start an AI draft of the task this note should
// become. Returns the plan's id immediately (202, same async contract as
// POST /api/plan): the client polls GET /api/plan/:id for the proposal and
// confirms it through POST /api/plan/:id/confirm, which is still the only
// place a task actually gets written.
function enrichNote(ctx: ApiContext, id: string): Response {
  const note = ctx.noteStore.get(id);
  if (note === null) return errorResponse(404, `note not found: ${id}`);
  if (note.linkedTaskId !== null) {
    return errorResponse(409, `note already promoted: ${note.linkedTaskId}`);
  }
  const record = ctx.planManager.startPlan(
    buildNoteEnrichPrompt(note),
    'claude',
    note.id
  );
  return jsonResponse({ planId: record.id }, 202);
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
    if (
      segments[0] === 'config' &&
      segments.length === 1 &&
      method === 'PATCH'
    ) {
      return await patchConfig(req, ctx);
    }

    if (segments[0] === 'tasks') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(
          ctx.cache.query({
            status: url.searchParams.get('status') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            parent: url.searchParams.get('parent') ?? undefined,
            includeArchived: url.searchParams.get('archived') === '1',
          })
        );
      }
      if (segments.length === 1 && method === 'POST') {
        return await createTask(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'draft' &&
        method === 'POST'
      ) {
        return await draftTask(req, ctx);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'enrich' &&
        method === 'POST'
      ) {
        return enrichTask(ctx, segments[1]);
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
        return jsonResponse(
          ctx.orchestrator.decorateRunsWithPushed(ctx.orchestrator.list())
        );
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
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'GET'
      ) {
        return listReviewComments(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'POST'
      ) {
        return await addReviewComment(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'comments' &&
        method === 'PATCH'
      ) {
        return await updateReviewComment(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'comments' &&
        segments[4] === 'reply' &&
        method === 'POST'
      ) {
        return await replyReviewComment(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'send-back' &&
        method === 'POST'
      ) {
        return await sendBackRun(req, ctx, segments[1]);
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

    // GET /api/prs (item B): every open PR in the repo — see
    // PrManager.listRepoPrs for the gh call + parsing, and its 409 when this
    // project lacks the `pr` capability (mapped by the typed-error catch
    // below, same as every other PR route).
    if (segments[0] === 'prs') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(await ctx.prManager.listRepoPrs());
      }
      // GET /api/prs/:number/detail, POST /api/prs/:number/review, POST
      // /api/prs/:number/comment — the in-app review surface for "Other open
      // PRs" (repo PRs dispatch never opened itself, so there's no run to key
      // off). Each resolves `number` to its url via listRepoPrs() (404 when
      // it isn't among the repo's open PRs), then delegates to the same
      // URL-driven PrManager cores the run-keyed routes above use — this is
      // what keeps dispatch from becoming an open proxy for reviewing/
      // commenting on an arbitrary PR url a client might otherwise supply
      // directly.
      if (
        segments.length === 3 &&
        segments[2] === 'detail' &&
        method === 'GET'
      ) {
        return await getRepoPrDetail(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await reviewRepoPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comment' &&
        method === 'POST'
      ) {
        return await commentRepoPr(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'branches') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.orchestrator.listBranches());
      }
      if (
        segments.length === 2 &&
        segments[1] === 'free-disk' &&
        method === 'POST'
      ) {
        return await freeBranchDisk(req, ctx);
      }
      // Everything after `branches/` is one branch name that happens to
      // contain slashes — `segments` already split it apart, so rejoin it and
      // decode each part back to its original form.
      if (segments.length >= 2 && method === 'DELETE') {
        const branch = segments
          .slice(1)
          .map((part) => decodeURIComponent(part))
          .join('/');
        return deleteBranch(ctx, branch, url);
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
      if (
        segments.length === 3 &&
        segments[2] === 'enrich' &&
        method === 'POST'
      ) {
        return enrichNote(ctx, segments[1]);
      }
    }

    if (segments[0] === 'inbox') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.inboxStore.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await addInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'convert' &&
        method === 'POST'
      ) {
        return await convertInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'dismiss' &&
        method === 'POST'
      ) {
        return await dismissInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'cluster' &&
        method === 'POST'
      ) {
        return await clusterInbox(ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateInbox(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'enrich' &&
        method === 'POST'
      ) {
        return enrichInbox(ctx, segments[1]);
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
        segments[2] === 'message' &&
        method === 'POST'
      ) {
        return await sendPlanMessage(req, ctx, segments[1]);
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
      if (
        segments.length === 2 &&
        segments[1] === 'stack' &&
        method === 'POST'
      ) {
        return await enqueueMergeQueueStack(req, ctx);
      }
      // POST /api/merge-queue/ready. Enqueues every mergeable run in the
      // registry at once — an empty `[]` is a valid 201, not an error.
      if (
        segments.length === 2 &&
        segments[1] === 'ready' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.mergeQueue.enqueueReady(), 201);
      }
      // POST /api/merge-queue/recheck. Re-runs the pump against the current
      // main checkout — the retry for entries held in 'blocked-environment'
      // (dirty tree, staged index, wrong branch). Those blockers are resolved
      // by the user in a terminal, which produces no event this daemon can
      // observe, so there has to be an explicit "I've cleaned up, try again"
      // call. Takes no body and always 200s with the resulting snapshot: it's
      // a nudge, not an assertion that anything is currently blocked.
      if (
        segments.length === 2 &&
        segments[1] === 'recheck' &&
        method === 'POST'
      ) {
        ctx.mergeQueue.recheck();
        return jsonResponse(ctx.mergeQueue.snapshot());
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
