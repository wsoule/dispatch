import {
  ASSIGNEES,
  clearCredential,
  ConfigError,
  getSection,
  KINDS,
  loadConfig,
  PRIORITIES,
  TaskParseError,
  TaskStore,
  updateConfig,
  writeCredential,
} from '@dispatch/core';
import type {
  ConfigPatch,
  CreateInput,
  DispatchConfig,
  FixLoopConfig,
  LinearConfig,
  ModelConfig,
  UpdatePatch,
  VerifyConfig,
} from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';

import { amendTask } from './api/amendments.js';
import {
  createFinding,
  createLedgerEntry,
  listFindings,
  listLedger,
  updateFinding,
} from './api/findings.js';
import {
  adjudicateFinding,
  advanceFixLoop,
  getFixLoop,
} from './api/fixLoop.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from './api/http.js';
import { listTaskFindings, startTaskReview } from './api/review.js';
import { createRunEvidence, createRunMutation } from './api/runEvidence.js';
import {
  decideScopeRequest,
  getScopeRequest,
  requestScope,
} from './api/scopeRequests.js';
import { getTaskVerification, startTaskVerification } from './api/verify.js';
import type { TaskCache } from './cache.js';
import type { EventBus } from './events.js';
import type { FindingStore } from './findings.js';
import {
  COMMIT_SHA_UNRESOLVED_PREFIX,
  CONFIRM_REQUIRED_ERROR,
  INVALID_REF_ERROR,
  INVALID_REMOTE_ERROR,
  INVALID_STASH_INDEX_ERROR,
  PATH_ESCAPE_ERROR,
} from './git/commands.js';
import type { GitOutcome, GitRepo } from './git/commands.js';
import { CommitMessageGenerator } from './git/commitMessage.js';
import type { GitBranch } from './git/parse.js';
import type { InboxItem, InboxKind } from './inbox.js';
import { INBOX_KINDS, type InboxStore } from './inbox.js';
import { InboxClusterer } from './inboxClusterer.js';
import type { LedgerStore } from './ledger.js';
import { HttpLinearClient } from './linear/client.js';
import type { LinearSync } from './linear/sync.js';
import type { Note, NoteKind } from './notes.js';
import { NOTE_KINDS, type NoteStore } from './notes.js';
import type { EpicEngine } from './orchestrator/epic.js';
import type { FixLoop } from './orchestrator/fixLoop.js';
import type { MergeQueue } from './orchestrator/mergeQueue.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { PlanManager } from './orchestrator/plan.js';
import type { PrManager } from './orchestrator/pr.js';
import type {
  QuestionRegistry,
  RunQuestion,
} from './orchestrator/questions.js';
import { QUESTION_POLL_MS } from './orchestrator/questions.js';
import type { ReviewRunner } from './orchestrator/review.js';
import type { ScopeRequestRegistry } from './orchestrator/scopeRequests.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './orchestrator/types.js';
import type { VerificationRunner } from './orchestrator/verify.js';
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
  findingStore: FindingStore;
  ledgerStore: LedgerStore;
  reviewRunner: ReviewRunner;
  verificationRunner: VerificationRunner;
  fixLoop: FixLoop;
  inboxClusterer?: InboxClusterer;
  reviewComments: ReviewCommentStore;
  questions: QuestionRegistry;
  scopeRequests: ScopeRequestRegistry;
  linearSync: LinearSync;
  // Cached once at boot (see pr.ts's detectPrCapability) — exposed at
  // GET /api/health as `pr` so a client can hide/disable the PR action
  // without probing per-run.
  prCapability: boolean;
  // The Git page's backend — see packages/server/src/git/commands.ts.
  gitRepo: GitRepo;
  // Test-injection seam only, same as `inboxClusterer` above.
  commitMessageGenerator?: CommitMessageGenerator;
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

// POST /api/tasks/draft — starts a background planner turn and returns the
// DraftRecord immediately (202); `planner` follows createRun's `executor` contract.
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
  const draft = ctx.planManager.startDraft(body.prompt, plannerName);
  return jsonResponse(draft, 202);
}

// GET /api/tasks/drafts — every draft currently held in memory (running,
// ready, or failed — until dismissed), newest first.
function listDrafts(ctx: ApiContext): Response {
  return jsonResponse(ctx.planManager.listDrafts());
}

// GET /api/tasks/drafts/:id — one draft record, 404 for an unknown id (via
// handleApi's outer OrchestratorNotFoundError catch).
function getDraft(ctx: ApiContext, id: string): Response {
  return jsonResponse(ctx.planManager.getDraft(id));
}

// DELETE /api/tasks/drafts/:id — dismisses a draft; getDraft() below 404s
// an unknown id before dismissDraft runs.
function dismissDraft(ctx: ApiContext, id: string): Response {
  ctx.planManager.getDraft(id);
  ctx.planManager.dismissDraft(id);
  return jsonResponse({ ok: true });
}

// POST /api/tasks/drafts/:id/message — mirrors sendPlanMessage's shape for a draft.
async function sendDraftMessage(
  req: Request,
  ctx: ApiContext,
  draftId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const record = ctx.planManager.sendDraftMessage(draftId, body.text);
  return jsonResponse(record, 202);
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
  // A request that omits `model` falls back to the project's configured
  // `models.execute` rather than leaving it undefined — a client that never
  // sends one (a script, an older UI build) still runs on the model the
  // project actually chose in settings, not whatever the SDK happens to
  // default to.
  const model =
    typeof modelField === 'string'
      ? modelField
      : loadConfig(ctx.rootDir).models.execute;
  const meta = await ctx.orchestrator.dispatch(taskId, executorName, {
    model,
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
  const body = parsed.value as {
    requestId?: unknown;
    allow?: unknown;
    scope?: unknown;
    reason?: unknown;
  };
  if (typeof body.requestId !== 'string' || body.requestId.trim() === '') {
    return errorResponse(400, 'invalid requestId: requestId is required');
  }
  if (typeof body.allow !== 'boolean') {
    return errorResponse(400, 'invalid allow: expected a boolean');
  }
  if (
    body.scope !== undefined &&
    body.scope !== 'once' &&
    body.scope !== 'session'
  ) {
    return errorResponse(400, "invalid scope: expected 'once' or 'session'");
  }
  ctx.orchestrator.approve(runId, body.requestId, {
    allow: body.allow,
    scope: body.scope,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
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
  if ('models' in body) {
    if (
      typeof body.models !== 'object' ||
      body.models === null ||
      Array.isArray(body.models)
    ) {
      return errorResponse(400, 'models must be an object');
    }
    // Same deal as permissionMode: the valid role set and per-role string check live in core
    // next to updateConfig, which rejects an unknown role or bad value before writing anything —
    // that ConfigError becomes the 400 below.
    patch.models = body.models as Partial<ModelConfig>;
  }
  if ('linear' in body) {
    if (
      typeof body.linear !== 'object' ||
      body.linear === null ||
      Array.isArray(body.linear)
    ) {
      return errorResponse(400, 'linear must be an object');
    }
    if ('apiKey' in (body.linear as Record<string, unknown>)) {
      return errorResponse(
        400,
        'the Linear API key is set through POST /api/linear/connect, not config'
      );
    }
    // Same deal as models: core validates each field before writing, and that
    // ConfigError becomes the 400 below.
    patch.linear = body.linear as Partial<LinearConfig>;
  }
  if ('fixLoop' in body) {
    if (
      typeof body.fixLoop !== 'object' ||
      body.fixLoop === null ||
      Array.isArray(body.fixLoop)
    ) {
      return errorResponse(400, 'fixLoop must be an object');
    }
    // Same deal as models/linear: core validates cap/escalation before
    // writing, and that ConfigError becomes the 400 below.
    patch.fixLoop = body.fixLoop as Partial<FixLoopConfig>;
  }
  if ('verify' in body) {
    if (
      typeof body.verify !== 'object' ||
      body.verify === null ||
      Array.isArray(body.verify)
    ) {
      return errorResponse(400, 'verify must be an object');
    }
    // Same deal as models/linear: core validates each field before writing,
    // and that ConfigError becomes the 400 below.
    patch.verify = body.verify as Partial<VerifyConfig>;
  }

  try {
    const config = updateConfig(ctx.rootDir, patch);
    ctx.events.broadcast({ type: 'config.changed' });
    // A changed interval or enabled flag only takes effect once the poll timer is rebuilt.
    ctx.linearSync.start();
    return jsonResponse(config);
  } catch (err) {
    return errorResponse(400, (err as Error).message);
  }
}

// Maps a Linear client failure onto a status code: a bad key is the caller's
// problem, a throttle is worth surfacing distinctly, anything else is upstream.
function linearErrorResponse(failure: {
  kind: string;
  error: string;
}): Response {
  const status =
    failure.kind === 'auth' ? 401 : failure.kind === 'rate-limit' ? 429 : 502;
  return errorResponse(status, failure.error);
}

// POST /api/linear/connect — check the key against `viewer` before storing it in
// `~/.dispatch/credentials.json`. The response carries the authenticated user, never the key.
async function connectLinear(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { apiKey?: unknown };
  if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') {
    return errorResponse(400, 'apiKey must be a non-empty string');
  }
  const apiKey = body.apiKey.trim();
  const result = await new HttpLinearClient(apiKey).viewer();
  if (!result.ok) return linearErrorResponse(result);
  writeCredential('linear', { apiKey });
  ctx.events.broadcast({ type: 'config.changed' });
  return jsonResponse({ connected: true, viewer: result.data });
}

// POST /api/linear/disconnect — forget the stored key. A LINEAR_API_KEY in the
// environment still wins afterwards, which `status.keySource` makes visible.
function disconnectLinear(ctx: ApiContext): Response {
  clearCredential('linear');
  ctx.events.broadcast({ type: 'config.changed' });
  return jsonResponse(ctx.linearSync.status());
}

// GET /api/linear/teams — the team picker's options.
async function linearTeams(ctx: ApiContext): Promise<Response> {
  const client = ctx.linearSync.client();
  if (client === null)
    return errorResponse(409, 'no Linear API key configured');
  const result = await client.teams();
  return result.ok ? jsonResponse(result.data) : linearErrorResponse(result);
}

// GET /api/linear/states?teamId= — the workflow states a status map can point at.
async function linearStates(
  ctx: ApiContext,
  teamId: string | null
): Promise<Response> {
  if (teamId === null || teamId.trim() === '') {
    return errorResponse(400, 'teamId is required');
  }
  const client = ctx.linearSync.client();
  if (client === null)
    return errorResponse(409, 'no Linear API key configured');
  const result = await client.workflowStates(teamId);
  return result.ok ? jsonResponse(result.data) : linearErrorResponse(result);
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
    startLine?: unknown;
    anchorText?: unknown;
    body?: unknown;
    pending?: unknown;
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
    startLine:
      typeof body.startLine === 'number' && Number.isInteger(body.startLine)
        ? body.startLine
        : undefined,
    anchorText: typeof body.anchorText === 'string' ? body.anchorText : '',
    body: body.body.trim(),
    pending: body.pending !== false,
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
 * POST /api/runs/:id/review — submit a review: publish its pending comments, then act on the
 * verdict.
 *
 * The three verdicts map onto what this app can already do with a finished run, rather than
 * inventing a parallel notion of review state:
 *
 *   approve         -> the work is good; the caller enqueues it to land
 *   request-changes -> resume the agent on the same branch with the review attached
 *   comment         -> publish the notes and change nothing
 *
 * Comments are published BEFORE the verdict is acted on, and the count is returned either way,
 * so a verdict action that fails cannot swallow the reviewer's writing.
 */
async function submitReview(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { verdict?: unknown; body?: unknown };
  const verdict = body.verdict;
  if (
    verdict !== 'approve' &&
    verdict !== 'request-changes' &&
    verdict !== 'comment'
  ) {
    return errorResponse(
      400,
      "invalid verdict: expected 'approve', 'request-changes' or 'comment'"
    );
  }
  const summary = typeof body.body === 'string' ? body.body.trim() : '';

  // Requesting changes with nothing to say would resume the agent to tell it nothing, burning a
  // run. The other two verdicts are meaningful on their own.
  const pendingBefore = ctx.reviewComments.pendingCount(runId);
  if (verdict === 'request-changes' && summary === '' && pendingBefore === 0) {
    return errorResponse(
      400,
      'nothing to send back — leave a note or a comment first'
    );
  }

  const published = ctx.reviewComments.publishPending(runId);
  ctx.events.broadcast({ type: 'review.changed', runId });

  if (verdict === 'request-changes') {
    const threads = formatCommentsForAgent(ctx.reviewComments.list(runId));
    const message = [summary, threads].filter((p) => p !== '').join('\n\n');
    try {
      const meta = ctx.orchestrator.sendMessage(runId, message);
      return jsonResponse({ verdict, published, run: meta });
    } catch (err) {
      // The comments are already published — say so, so the caller knows the review landed even
      // though the resume did not.
      return jsonResponse(
        { verdict, published, error: (err as Error).message },
        409
      );
    }
  }

  if (verdict === 'approve') {
    try {
      const entry = ctx.mergeQueue.enqueue(runId);
      return jsonResponse({ verdict, published, queued: entry });
    } catch (err) {
      return jsonResponse(
        { verdict, published, error: (err as Error).message },
        409
      );
    }
  }

  return jsonResponse({ verdict, published });
}

/**
 * POST /api/runs/:id/archive — hide a finished run from the default Runs list.
 *
 * `{ "archived": true | false }`. Nothing is deleted: the transcript, the diff
 * snapshot and the review comments all stay. This is a display marker, and it
 * is reversible, which is why the body carries the desired state rather than
 * this being a one-way "archive" verb.
 */
async function archiveRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { archived?: unknown };
  if (typeof body.archived !== 'boolean') {
    return errorResponse(400, 'archived must be a boolean');
  }
  try {
    return jsonResponse(ctx.orchestrator.setRunArchived(runId, body.archived));
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

// A `GitBranch` joined with whatever run claims that name, mirroring
// Orchestrator.listBranches' join but for every branch, not just dispatch/*.
export interface GitBranchWithRun extends GitBranch {
  runId?: string;
  taskId?: string;
  taskTitle?: string;
}

// GET /api/git/branches's core: every local/remote branch git knows about,
// annotated with the run that owns it when one does.
async function gitBranches(
  ctx: ApiContext
): Promise<GitOutcome<{ branches: GitBranchWithRun[] }>> {
  const result = await ctx.gitRepo.branches();
  if (!result.ok) return result;
  const runByBranch = new Map(
    ctx.orchestrator.list().map((r) => [r.branch, r])
  );
  const branches = result.branches.map((branch) => {
    const run = runByBranch.get(branch.name);
    return {
      ...branch,
      runId: run?.id,
      taskId: run?.taskId,
      taskTitle: run?.taskTitle,
    };
  });
  return { ok: true, branches };
}

// GitRepo's own pre-flight rejections never touch git, so `alwaysBroadcast`
// below must not fire for them even though they report `ok: false`.
const PRE_FLIGHT_REJECTIONS: ReadonlySet<string> = new Set([
  PATH_ESCAPE_ERROR,
  INVALID_REF_ERROR,
  INVALID_REMOTE_ERROR,
  CONFIRM_REQUIRED_ERROR,
  INVALID_STASH_INDEX_ERROR,
]);

// Shared by every `/api/git/*` mutation route; `alwaysBroadcast` covers ops
// that can mutate the tree even on `ok: false` (a conflicted pull or discard).
function gitMutationResponse(
  ctx: ApiContext,
  result: GitOutcome,
  opts: { alwaysBroadcast?: boolean } = {}
): Response {
  const mutated =
    result.ok ||
    (opts.alwaysBroadcast === true &&
      !PRE_FLIGHT_REJECTIONS.has(result.stderr));
  if (mutated) ctx.events.broadcast({ type: 'git.changed' });
  return jsonResponse(result);
}

// Shared shape check for the routes that take a list of file paths (stage,
// unstage, discard) — requires a non-empty array of non-empty strings.
function requirePathList(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === 'string' && v !== '')
  ) {
    return null;
  }
  return value as string[];
}

async function gitStage(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const paths = requirePathList((parsed.value as { paths?: unknown }).paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  return gitMutationResponse(ctx, await ctx.gitRepo.stage(paths));
}

async function gitUnstage(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const paths = requirePathList((parsed.value as { paths?: unknown }).paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  return gitMutationResponse(ctx, await ctx.gitRepo.unstage(paths));
}

// POST /api/git/discard — destructive (drops uncommitted work with no undo),
// so it 400s outright unless the body carries `confirm: true`.
async function gitDiscard(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { paths?: unknown; confirm?: unknown };
  const paths = requirePathList(body.paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  if (body.confirm !== true) {
    return errorResponse(
      400,
      'discard is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.discard(paths, true), {
    alwaysBroadcast: true,
  });
}

async function gitStageHunk(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = (parsed.value as { patch?: unknown }).patch;
  if (typeof patch !== 'string' || patch === '') {
    return errorResponse(400, 'patch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stageHunk(patch));
}

async function gitUnstageHunk(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = (parsed.value as { patch?: unknown }).patch;
  if (typeof patch !== 'string' || patch === '') {
    return errorResponse(400, 'patch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.unstageHunk(patch));
}

async function gitCommit(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { message?: unknown; amend?: unknown };
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return errorResponse(400, 'message is required');
  }
  if (body.amend !== undefined && typeof body.amend !== 'boolean') {
    return errorResponse(400, 'amend must be a boolean');
  }
  const result = await ctx.gitRepo.commit({
    message: body.message,
    amend: body.amend === true,
  });
  // The commit itself can still have landed even when this reports `ok:
  // false` (rev-parse failed to confirm the sha) — broadcast that case too.
  const shaUnresolved =
    !result.ok && result.stderr.startsWith(COMMIT_SHA_UNRESOLVED_PREFIX);
  return gitMutationResponse(ctx, result, { alwaysBroadcast: shaUnresolved });
}

// POST /api/git/commit-message — the agent-focused route. 400s when nothing
// is staged; 502s a model failure rather than a generic 500.
async function gitCommitMessage(
  _req: Request,
  ctx: ApiContext
): Promise<Response> {
  const diff = await ctx.gitRepo.diff({ staged: true });
  if (!diff.ok) return errorResponse(409, diff.stderr);
  if (diff.patch.trim() === '') {
    return errorResponse(400, 'no staged changes to summarize');
  }
  const generator =
    ctx.commitMessageGenerator ?? new CommitMessageGenerator(ctx.rootDir);
  try {
    const message = await generator.generate(diff.patch);
    return jsonResponse({ message });
  } catch (err) {
    return errorResponse(502, (err as Error).message);
  }
}

async function gitCheckout(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const branch = (parsed.value as { branch?: unknown }).branch;
  if (typeof branch !== 'string' || branch === '') {
    return errorResponse(400, 'branch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.checkout(branch));
}

async function gitCreateBranch(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; from?: unknown };
  if (typeof body.name !== 'string' || body.name === '') {
    return errorResponse(400, 'name is required');
  }
  if (body.from !== undefined && typeof body.from !== 'string') {
    return errorResponse(400, 'from must be a string');
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.createBranch(body.name, body.from)
  );
}

// DELETE /api/git/branch/:name — `force: true` (git's `-D`) 400s unless the
// body also carries `confirm: true`; a plain `-d` delete needs no confirm.
async function gitDeleteBranch(
  req: Request,
  ctx: ApiContext,
  name: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { force?: unknown; confirm?: unknown };
  const force = body.force === true;
  if (force && body.confirm !== true) {
    return errorResponse(
      400,
      'deleting an unmerged branch is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.deleteBranch(name, force, body.confirm === true)
  );
}

async function gitStashPush(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const message = (parsed.value as { message?: unknown }).message;
  if (message !== undefined && typeof message !== 'string') {
    return errorResponse(400, 'message must be a string');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stashPush(message));
}

function requireStashIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

async function gitStashPop(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const index = requireStashIndex((parsed.value as { index?: unknown }).index);
  if (index === null)
    return errorResponse(400, 'index is required: a non-negative integer');
  return gitMutationResponse(ctx, await ctx.gitRepo.stashPop(index), {
    alwaysBroadcast: true,
  });
}

// POST /api/git/stash/drop — destructive (the stash entry is gone for good),
// so it 400s outright unless the body carries `confirm: true`.
async function gitStashDrop(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { index?: unknown; confirm?: unknown };
  const index = requireStashIndex(body.index);
  if (index === null)
    return errorResponse(400, 'index is required: a non-negative integer');
  if (body.confirm !== true) {
    return errorResponse(
      400,
      'dropping a stash is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stashDrop(index, true));
}

async function gitFetch(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const remote = (parsed.value as { remote?: unknown }).remote;
  if (remote !== undefined && typeof remote !== 'string') {
    return errorResponse(400, 'remote must be a string');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.fetch(remote));
}

async function gitPush(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const setUpstream = (parsed.value as { setUpstream?: unknown }).setUpstream;
  if (setUpstream !== undefined && typeof setUpstream !== 'boolean') {
    return errorResponse(400, 'setUpstream must be a boolean');
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.push({ setUpstream: setUpstream === true })
  );
}

async function gitCherryPick(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const sha = (parsed.value as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || sha === '')
    return errorResponse(400, 'sha is required');
  return gitMutationResponse(ctx, await ctx.gitRepo.cherryPick(sha), {
    alwaysBroadcast: true,
  });
}

async function gitRevert(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const sha = (parsed.value as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || sha === '')
    return errorResponse(400, 'sha is required');
  return gitMutationResponse(ctx, await ctx.gitRepo.revert(sha), {
    alwaysBroadcast: true,
  });
}

// Absent -> undefined; a valid non-negative integer -> that number;
// otherwise -> null so the route can 400 instead of passing NaN to git.
function parseCountParam(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
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

// The transcript text a question lands as, so the session log records what
// was asked without depending on a card the user may already have dismissed.
function questionEntryText(question: string, options: string[]): string {
  if (options.length === 0) return question;
  return `${question}\n\n${options.map((o) => `- ${o}`).join('\n')}`;
}

// POST /api/runs/:id/questions — `ask_user` posts here, then long-polls the
// GET below. `messageUser` writes the entry and gates this to a live run.
async function askQuestion(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { question?: unknown; options?: unknown };
  if (typeof body.question !== 'string' || body.question.trim() === '') {
    return errorResponse(400, 'invalid question: question is required');
  }
  if (
    body.options !== undefined &&
    (!Array.isArray(body.options) ||
      body.options.some((o) => typeof o !== 'string'))
  ) {
    return errorResponse(400, 'invalid options: expected an array of strings');
  }
  const question = body.question.trim();
  const options = ((body.options as string[] | undefined) ?? [])
    .map((o) => o.trim())
    .filter((o) => o !== '');

  ctx.orchestrator.messageUser(runId, questionEntryText(question, options));
  const record = ctx.questions.ask(runId, question, options);
  ctx.events.broadcast({
    type: 'question.asked',
    runId,
    questionId: record.id,
  });
  return jsonResponse(record, 201);
}

// Resolves a question id against its own run, so one run can never read or
// answer another run's question by guessing an id.
function questionFor(
  ctx: ApiContext,
  runId: string,
  questionId: string
): RunQuestion | null {
  const record = ctx.questions.get(questionId);
  return record !== undefined && record.runId === runId ? record : null;
}

// GET /api/runs/:id/questions/:qid — `?wait=1` parks for up to
// QUESTION_POLL_MS. Coming back unanswered means "poll again", not an error.
async function getQuestion(
  req: Request,
  ctx: ApiContext,
  runId: string,
  questionId: string
): Promise<Response> {
  const record = questionFor(ctx, runId, questionId);
  if (record === null) {
    return errorResponse(404, `question not found: ${questionId}`);
  }
  const wait = new URL(req.url).searchParams.get('wait') === '1';
  if (!wait) return jsonResponse(record);
  return jsonResponse(
    await ctx.questions.waitForAnswer(questionId, QUESTION_POLL_MS)
  );
}

// POST /api/runs/:id/questions/:qid/answer — unblocks whatever is parked on
// the long-poll above. 409s on a second answer: the first one already went.
async function answerQuestion(
  req: Request,
  ctx: ApiContext,
  runId: string,
  questionId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { answer?: unknown };
  if (typeof body.answer !== 'string' || body.answer.trim() === '') {
    return errorResponse(400, 'invalid answer: answer is required');
  }
  if (questionFor(ctx, runId, questionId) === null) {
    return errorResponse(404, `question not found: ${questionId}`);
  }
  const record = ctx.questions.answer(questionId, body.answer.trim());
  // The agent already has the answer by this point, so a run that vanished
  // out from under the transcript write must not turn this into a failure.
  try {
    ctx.orchestrator.recordAnswer(runId, body.answer.trim());
  } catch (err) {
    if (!(err instanceof OrchestratorNotFoundError)) throw err;
  }
  ctx.events.broadcast({ type: 'question.answered', runId, questionId });
  ctx.events.broadcast({ type: 'run.changed' });
  return jsonResponse(record);
}

// DELETE /api/runs/:id/questions/:qid — the asking agent stopped listening
// (its tool call was cancelled or gave up), so the card must stop asking.
function withdrawQuestion(
  ctx: ApiContext,
  runId: string,
  questionId: string
): Response {
  if (questionFor(ctx, runId, questionId) === null) {
    return errorResponse(404, `question not found: ${questionId}`);
  }
  ctx.questions.withdraw(questionId);
  ctx.events.broadcast({ type: 'question.closed', runId });
  return new Response(null, { status: 204 });
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
 * Runs automatically in the background (BrainDumpView), so always 200 with `error` set on
 * failure rather than a 502 — a background pass must never read as a hard failure.
 */
async function clusterInbox(ctx: ApiContext): Promise<Response> {
  const clusterer = ctx.inboxClusterer ?? new InboxClusterer(ctx.rootDir);
  try {
    const groups = await clusterer.cluster(ctx.inboxStore.list());
    return jsonResponse({ groups, error: null });
  } catch (err) {
    return jsonResponse({ groups: [], error: (err as Error).message });
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
    item.id,
    'enrich'
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
function buildTaskEnrichPrompt(task: TaskDoc): string {
  // The two spec sections only — `task.body` verbatim would carry the template's empty
  // headings (so no task ever looks empty) and the agent-written Activity log.
  const existing = [
    getSection(task.body, 'Description'),
    getSection(task.body, 'Acceptance Criteria'),
  ]
    .filter((section) => section !== '')
    .join('\n\n');
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

// POST /api/tasks/:id/enrich — AI-draft fuller detail for an existing task. The plan only
// carries the draft; the client applies it via PATCH /api/tasks/:id, never confirm (which
// creates new tasks). No sourceNoteId either — that field is for note-derived plans only.
function enrichTask(ctx: ApiContext, id: string): Response {
  const task = ctx.cache.get(id);
  if (task === null || task === undefined) {
    return errorResponse(404, `task not found: ${id}`);
  }
  const record = ctx.planManager.startPlan(
    buildTaskEnrichPrompt(task),
    'claude',
    undefined,
    'enrich'
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
    note.id,
    'enrich'
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

    if (segments[0] === 'linear' && segments.length === 2) {
      if (segments[1] === 'status' && method === 'GET') {
        return jsonResponse(ctx.linearSync.status());
      }
      if (segments[1] === 'connect' && method === 'POST') {
        return await connectLinear(req, ctx);
      }
      if (segments[1] === 'disconnect' && method === 'POST') {
        return disconnectLinear(ctx);
      }
      if (segments[1] === 'teams' && method === 'GET') {
        return await linearTeams(ctx);
      }
      // GET /api/linear/links — issue UUID -> { identifier, url }, so a client
      // holding only `TaskMeta.external` can render a real "ENG-123" chip.
      if (segments[1] === 'links' && method === 'GET') {
        return jsonResponse(ctx.linearSync.links());
      }
      // POST /api/linear/import — bring down Linear issues that have no local
      // task. Deliberately explicit: an ordinary sync never imports a backlog.
      if (segments[1] === 'import' && method === 'POST') {
        return jsonResponse(await ctx.linearSync.importIssues());
      }
      if (segments[1] === 'states' && method === 'GET') {
        return await linearStates(ctx, url.searchParams.get('teamId'));
      }
      // POST /api/linear/sync — run a pass now. An optional `taskIds` array pushes exactly
      // those tasks, bypassing the gate that keeps a first sync from flooding the workspace.
      if (segments[1] === 'sync' && method === 'POST') {
        const parsed = await readJsonBodyOptional(req);
        if (!parsed.ok) return parsed.response;
        const raw = parsed.value.taskIds;
        if (
          raw !== undefined &&
          (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
        ) {
          return errorResponse(400, 'taskIds must be a list of strings');
        }
        return jsonResponse(await ctx.linearSync.syncOnce(raw));
      }
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
      // Checked before the generic `:id` GET branch below, so "drafts"
      // isn't treated as a task id.
      if (
        segments.length === 2 &&
        segments[1] === 'drafts' &&
        method === 'GET'
      ) {
        return listDrafts(ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'drafts' &&
        method === 'GET'
      ) {
        return getDraft(ctx, segments[2]);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'drafts' &&
        method === 'DELETE'
      ) {
        return dismissDraft(ctx, segments[2]);
      }
      if (
        segments.length === 4 &&
        segments[1] === 'drafts' &&
        segments[3] === 'message' &&
        method === 'POST'
      ) {
        return await sendDraftMessage(req, ctx, segments[2]);
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
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await startTaskReview(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'verify' &&
        method === 'POST'
      ) {
        return await startTaskVerification(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'verification' &&
        method === 'GET'
      ) {
        return getTaskVerification(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'findings' &&
        method === 'GET'
      ) {
        return listTaskFindings(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'fix-loop' &&
        method === 'GET'
      ) {
        return getFixLoop(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'amend' &&
        method === 'POST'
      ) {
        return await amendTask(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'fix-loop' &&
        segments[3] === 'advance' &&
        method === 'POST'
      ) {
        return await advanceFixLoop(req, ctx, segments[1]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'findings' &&
        segments[4] === 'adjudicate' &&
        method === 'POST'
      ) {
        return await adjudicateFinding(req, ctx, segments[1], segments[3]);
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
        segments[2] === 'evidence' &&
        method === 'POST'
      ) {
        return await createRunEvidence(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'mutations' &&
        method === 'POST'
      ) {
        return await createRunMutation(req, ctx, segments[1]);
      }
      // POST /api/runs/:id/resume — agent-death recovery: dispatches a fresh
      // run into the same worktree, carrying the prior run's survey.
      if (
        segments.length === 3 &&
        segments[2] === 'resume' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.orchestrator.resumeRun(segments[1]), 201);
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
      if (
        segments.length === 3 &&
        segments[2] === 'review-submit' &&
        method === 'POST'
      ) {
        return await submitReview(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'archive' &&
        method === 'POST'
      ) {
        return await archiveRun(req, ctx, segments[1]);
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
      if (
        segments.length === 3 &&
        segments[2] === 'questions' &&
        method === 'POST'
      ) {
        return await askQuestion(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'questions' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.questions.listOpen(segments[1]));
      }
      if (
        segments.length === 4 &&
        segments[2] === 'questions' &&
        method === 'GET'
      ) {
        return await getQuestion(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'questions' &&
        method === 'DELETE'
      ) {
        return withdrawQuestion(ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'questions' &&
        segments[4] === 'answer' &&
        method === 'POST'
      ) {
        return await answerQuestion(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'scope-requests' &&
        method === 'POST'
      ) {
        return await requestScope(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'scope-requests' &&
        method === 'GET'
      ) {
        return await getScopeRequest(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'scope-requests' &&
        segments[4] === 'decide' &&
        method === 'POST'
      ) {
        return await decideScopeRequest(req, ctx, segments[1], segments[3]);
      }
    }

    // GET /api/questions — every open question across every run, for the
    // app's "an agent is waiting on you" surfaces.
    if (segments[0] === 'questions' && segments.length === 1) {
      if (method === 'GET') return jsonResponse(ctx.questions.listOpen());
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

    // The Git page — status/log/branches/diff reads plus staging, committing,
    // checkout, stash, and remote mutations against the main checkout.
    if (segments[0] === 'git') {
      if (
        segments.length === 2 &&
        segments[1] === 'status' &&
        method === 'GET'
      ) {
        return jsonResponse(await ctx.gitRepo.status());
      }
      if (segments.length === 2 && segments[1] === 'log' && method === 'GET') {
        const limit = parseCountParam(url.searchParams.get('limit'));
        if (limit === null)
          return errorResponse(400, 'limit must be a non-negative integer');
        const skip = parseCountParam(url.searchParams.get('skip'));
        if (skip === null)
          return errorResponse(400, 'skip must be a non-negative integer');
        return jsonResponse(
          await ctx.gitRepo.log({
            ref: url.searchParams.get('ref') ?? undefined,
            limit,
            skip,
          })
        );
      }
      if (
        segments.length === 2 &&
        segments[1] === 'branches' &&
        method === 'GET'
      ) {
        return jsonResponse(await gitBranches(ctx));
      }
      if (segments.length === 2 && segments[1] === 'diff' && method === 'GET') {
        return jsonResponse(
          await ctx.gitRepo.diff({
            staged: url.searchParams.get('staged') === '1',
            path: url.searchParams.get('path') ?? undefined,
          })
        );
      }
      if (
        segments.length === 3 &&
        segments[1] === 'commit' &&
        method === 'GET'
      ) {
        return jsonResponse(
          await ctx.gitRepo.diffCommit(decodeURIComponent(segments[2]))
        );
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stage' &&
        method === 'POST'
      ) {
        return await gitStage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'unstage' &&
        method === 'POST'
      ) {
        return await gitUnstage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stage-hunk' &&
        method === 'POST'
      ) {
        return await gitStageHunk(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'unstage-hunk' &&
        method === 'POST'
      ) {
        return await gitUnstageHunk(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'discard' &&
        method === 'POST'
      ) {
        return await gitDiscard(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'commit' &&
        method === 'POST'
      ) {
        return await gitCommit(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'commit-message' &&
        method === 'POST'
      ) {
        return await gitCommitMessage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'checkout' &&
        method === 'POST'
      ) {
        return await gitCheckout(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'branch' &&
        method === 'POST'
      ) {
        return await gitCreateBranch(req, ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'branch' &&
        method === 'DELETE'
      ) {
        return await gitDeleteBranch(req, ctx, decodeURIComponent(segments[2]));
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stash' &&
        method === 'POST'
      ) {
        return await gitStashPush(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stash' &&
        method === 'GET'
      ) {
        return jsonResponse(await ctx.gitRepo.stashList());
      }
      if (
        segments.length === 3 &&
        segments[1] === 'stash' &&
        segments[2] === 'pop' &&
        method === 'POST'
      ) {
        return await gitStashPop(req, ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'stash' &&
        segments[2] === 'drop' &&
        method === 'POST'
      ) {
        return await gitStashDrop(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'fetch' &&
        method === 'POST'
      ) {
        return await gitFetch(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'pull' &&
        method === 'POST'
      ) {
        return gitMutationResponse(ctx, await ctx.gitRepo.pull(), {
          alwaysBroadcast: true,
        });
      }
      if (
        segments.length === 2 &&
        segments[1] === 'push' &&
        method === 'POST'
      ) {
        return await gitPush(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'cherry-pick' &&
        method === 'POST'
      ) {
        return await gitCherryPick(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'revert' &&
        method === 'POST'
      ) {
        return await gitRevert(req, ctx);
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

    if (segments[0] === 'findings') {
      if (segments.length === 1 && method === 'GET') {
        return listFindings(ctx, url);
      }
      if (segments.length === 1 && method === 'POST') {
        return await createFinding(req, ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateFinding(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'ledger') {
      if (segments.length === 1 && method === 'GET') {
        return listLedger(ctx, url);
      }
      if (segments.length === 1 && method === 'POST') {
        return await createLedgerEntry(req, ctx);
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
