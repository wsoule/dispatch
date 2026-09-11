import { describePolicyAuthorization } from '@dispatch/core';

import type { ApiContext } from '../api.js';
import { scopeRequestEscapesRepo } from '../floor.js';
import {
  SCOPE_REQUEST_POLL_MS,
  scopePathsInsideRepo,
} from '../orchestrator/scopeRequests.js';
import type {
  RunScopeRequest,
  ScopeDecider,
} from '../orchestrator/scopeRequests.js';
import { OrchestratorConflictError } from '../orchestrator/types.js';
import {
  consultProjectPolicy,
  policyActivityAppender,
} from '../policyEngine.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The transcript text a scope request lands as, so the session log records
// what an agent asked to touch outside its fence and why.
function scopeRequestEntryText(paths: string[], reason: string): string {
  return `Requesting to edit outside my scope: ${paths.join(', ')}\n\n${reason}`;
}

// POST /api/runs/:id/scope-requests — an agent asks to edit outside its
// fence. `messageUser` writes the transcript entry and gates this to a live run.
export async function requestScope(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { paths?: unknown; reason?: unknown };
  if (
    !Array.isArray(body.paths) ||
    body.paths.length === 0 ||
    body.paths.some((p) => typeof p !== 'string' || p.trim() === '')
  ) {
    return errorResponse(
      400,
      'invalid paths: expected a non-empty array of strings'
    );
  }
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return errorResponse(400, 'invalid reason: reason is required');
  }
  const paths = (body.paths as string[]).map((p) => p.trim());
  const reason = body.reason.trim();

  ctx.orchestrator.messageUser(runId, scopeRequestEntryText(paths, reason));
  // Idempotent on the path set: a resumed agent re-issuing the request its
  // previous process was parked on (carried here from the run a restart
  // killed) re-parks on the card the human already has, rather than putting a
  // second copy of it in front of them. 200, not 201 — nothing was created.
  const existing = ctx.scopeRequests.findOpen(runId, paths);
  if (existing !== null) return jsonResponse(existing);
  const record = ctx.scopeRequests.request(runId, paths, reason);
  ctx.events.broadcast({
    type: 'scope.requested',
    runId,
    requestId: record.id,
  });
  // The policy consult this gate demotes through: at or above the scope rung
  // the request is granted on the spot and recorded — same decide() path, same
  // ledger entry a human grant produces, plus an Activity line — instead of
  // parking the agent on a person. Below the rung nothing changes: the
  // request blocks as today. A request reaching outside the repo or into
  // .git/ is never policy's to grant: it parks for a human at every rung
  // (see scopeRequestEscapesRepo).
  const ruling = policyRulingForScope(ctx, runId, paths);
  if (ruling !== null) {
    const authorization = describePolicyAuthorization(ruling);
    const decided = ctx.scopeRequests.decide(
      record.id,
      true,
      authorization,
      'policy'
    );
    const taskId = recordGrantedLedgerEntry(ctx, runId, decided);
    if (taskId !== null) {
      policyActivityAppender(ctx)(
        taskId,
        `[policy] Scope extended for run ${runId}: ${paths.join(', ')} — ${authorization}`
      );
    }
    ctx.events.broadcast({
      type: 'scope.decided',
      runId,
      requestId: record.id,
    });
    return jsonResponse(decided, 201);
  }
  return jsonResponse(record, 201);
}

// GET /api/runs/:id/scope-requests — the run's still-undecided requests,
// oldest first. This is how a client finds a request it never saw the
// `scope.requested` event for: one that outlived a daemon restart, or one
// carried onto a resumed run. 404s an unknown run, like every run route.
export function listScopeRequests(ctx: ApiContext, runId: string): Response {
  if (ctx.orchestrator.getRun(runId) === null) {
    return errorResponse(404, `run not found: ${runId}`);
  }
  return jsonResponse(ctx.scopeRequests.listOpen(runId));
}

// The auto-grant authorization for one request, or null when it must park
// for a human: the task's risk caps the rung (a critical task never
// auto-extends), and only paths inside the run's own checkout and outside
// `.git/` qualify — anything else is the human's call at every rung. A run
// or task the daemon cannot find fails closed. The floor's own escape test
// runs first and is checked separately from the ladder, so no rung can reach
// a path that leaves the repo.
function policyRulingForScope(
  ctx: ApiContext,
  runId: string,
  paths: string[]
): Extract<ReturnType<typeof consultProjectPolicy>, { mode: 'auto' }> | null {
  if (scopeRequestEscapesRepo(paths).length > 0) return null;
  const run = ctx.orchestrator.list().find((r) => r.id === runId);
  const task = run === undefined ? null : ctx.store.get(run.taskId);
  if (run === undefined || task === null) return null;
  if (!scopePathsInsideRepo(paths, [run.worktreePath, ctx.rootDir])) {
    return null;
  }
  const ruling = consultProjectPolicy(ctx.rootDir, 'scope', task.meta.risk);
  return ruling.mode === 'auto' ? ruling : null;
}

// Resolves a request id against its own run, so one run can never read or
// decide another run's scope request by guessing an id.
function scopeRequestFor(
  ctx: ApiContext,
  runId: string,
  requestId: string
): RunScopeRequest | null {
  const record = ctx.scopeRequests.get(requestId);
  return record !== undefined && record.runId === runId ? record : null;
}

// GET /api/runs/:id/scope-requests/:rid — `?wait=1` parks for up to
// SCOPE_REQUEST_POLL_MS. Coming back undecided means "poll again", not an error.
export async function getScopeRequest(
  req: Request,
  ctx: ApiContext,
  runId: string,
  requestId: string
): Promise<Response> {
  const record = scopeRequestFor(ctx, runId, requestId);
  if (record === null) {
    return errorResponse(404, `scope request not found: ${requestId}`);
  }
  const wait = new URL(req.url).searchParams.get('wait') === '1';
  if (!wait) return jsonResponse(record);
  return jsonResponse(
    await ctx.scopeRequests.waitForDecision(requestId, SCOPE_REQUEST_POLL_MS)
  );
}

// The desktop app's own webview origins, plus the loopback origins its dev
// harness runs under.
const APP_WEBVIEW_ORIGINS = new Set([
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
]);
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Who a decision is attributed to: a webview sends an `Origin`, an agent's own
// curl does not. Attribution, not authentication — the header is forgeable.
function deciderFor(req: Request): ScopeDecider {
  const origin = req.headers.get('origin');
  if (origin === null) return 'api';
  if (APP_WEBVIEW_ORIGINS.has(origin)) return 'app';
  return LOOPBACK_ORIGIN.test(origin) ? 'app' : 'api';
}

// A granted request extends what its task inherits: the paths it touched,
// and why, so the next task in the epic sees the fence actually moved.
// Returns the task the entry was filed under, when the run resolved to one.
function recordGrantedLedgerEntry(
  ctx: ApiContext,
  runId: string,
  record: RunScopeRequest
): string | null {
  const run = ctx.orchestrator.getRun(runId);
  const taskId = run?.meta.taskId ?? null;
  const task = taskId !== null ? ctx.store.get(taskId) : null;
  const why =
    record.decisionReason === null
      ? record.reason
      : `${record.reason} (${record.decisionReason})`;
  // A reader judging whether an out-of-fence edit was sanctioned needs to see
  // who sanctioned it, so the decider goes in the entry itself.
  const detail = `${record.paths.join(', ')} — ${why} [decided via ${record.decidedBy ?? 'api'}]`;
  ctx.ledgerStore.add({
    epicId: task?.meta.parent ?? null,
    sourceTaskId: taskId,
    kind: 'decision',
    title: `Scope extended for run ${runId}`,
    detail,
    authoredBy: ctx.actorContext.humanRef,
  });
  ctx.events.broadcast({ type: 'ledger.changed' });
  return taskId;
}

// POST /api/runs/:id/scope-requests/:rid/decide {granted, reason?} — unblocks
// the long-poll above. A grant is also carried to the ledger; 409s a second decision.
export async function decideScopeRequest(
  req: Request,
  ctx: ApiContext,
  runId: string,
  requestId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { granted?: unknown; reason?: unknown };
  if (typeof body.granted !== 'boolean') {
    return errorResponse(400, 'invalid granted: expected a boolean');
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return errorResponse(400, 'invalid reason: expected a string');
  }
  if (scopeRequestFor(ctx, runId, requestId) === null) {
    return errorResponse(404, `scope request not found: ${requestId}`);
  }
  let record: RunScopeRequest;
  try {
    record = ctx.scopeRequests.decide(
      requestId,
      body.granted,
      body.reason,
      deciderFor(req)
    );
  } catch (err) {
    if (err instanceof OrchestratorConflictError) {
      return errorResponse(409, err.message);
    }
    throw err;
  }
  if (record.granted === true) recordGrantedLedgerEntry(ctx, runId, record);
  ctx.events.broadcast({ type: 'scope.decided', runId, requestId });
  return jsonResponse(record);
}
