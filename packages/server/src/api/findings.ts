import type {
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
  LedgerKind,
} from '@dispatch/core';

import type { ApiContext } from '../api.js';
import { ADJUDICATION_VERDICTS } from '../orchestrator/fixLoop.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// Declared as `readonly string[]` (not the literal union) so a membership
// check against an unvalidated `unknown` never needs an `as` cast.
const SEVERITIES: readonly string[] = ['critical', 'important', 'minor'];
const VERDICTS: readonly string[] = ['open', 'addressed', 'parked', 'blocked'];
// `parked`/`blocked` are adjudications, not edits: they carry a mandatory
// ruling and side effects, so they only come in through the adjudicate route.
const PATCHABLE_VERDICTS: readonly string[] = ['open', 'addressed'];
const ADJUDICATED_ERROR =
  'through POST /api/tasks/:id/findings/:fid/adjudicate, which requires a ruling';
const RECOMMENDATIONS: readonly string[] = ['blocks', 'park'];
const LEDGER_KINDS: readonly string[] = [
  'constraint',
  'hazard',
  'decision',
  'handoff',
];

// GET /api/findings?taskId=&verdict=&severity=
export function listFindings(ctx: ApiContext, url: URL): Response {
  const verdict = url.searchParams.get('verdict');
  if (verdict !== null && !VERDICTS.includes(verdict)) {
    return errorResponse(400, `invalid verdict: ${verdict}`);
  }
  const severity = url.searchParams.get('severity');
  if (severity !== null && !SEVERITIES.includes(severity)) {
    return errorResponse(400, `invalid severity: ${severity}`);
  }
  return jsonResponse(
    ctx.findingStore.list({
      taskId: url.searchParams.get('taskId') ?? undefined,
      verdict: (verdict as FindingVerdict | null) ?? undefined,
      severity: (severity as FindingSeverity | null) ?? undefined,
    })
  );
}

// POST /api/findings — a review run raising a finding against a task.
export async function createFinding(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    taskId?: unknown;
    runId?: unknown;
    severity?: unknown;
    title?: unknown;
    detail?: unknown;
    file?: unknown;
    line?: unknown;
    round?: unknown;
    recommendation?: unknown;
  };
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    return errorResponse(400, 'invalid taskId: taskId is required');
  }
  if (
    typeof body.severity !== 'string' ||
    !SEVERITIES.includes(body.severity)
  ) {
    return errorResponse(
      400,
      `invalid severity: ${String(body.severity)} (expected ${SEVERITIES.join('|')})`
    );
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  if (typeof body.detail !== 'string' || body.detail.trim() === '') {
    return errorResponse(400, 'invalid detail: detail is required');
  }
  if (
    body.recommendation !== undefined &&
    (typeof body.recommendation !== 'string' ||
      !RECOMMENDATIONS.includes(body.recommendation))
  ) {
    return errorResponse(
      400,
      `invalid recommendation: ${String(body.recommendation)} (expected ${RECOMMENDATIONS.join('|')})`
    );
  }
  const finding = ctx.findingStore.add({
    taskId: body.taskId,
    runId: typeof body.runId === 'string' ? body.runId : null,
    severity: body.severity as FindingSeverity,
    title: body.title,
    detail: body.detail,
    file: typeof body.file === 'string' ? body.file : null,
    line: typeof body.line === 'number' ? body.line : null,
    round: typeof body.round === 'number' ? body.round : undefined,
    recommendation: body.recommendation as FindingRecommendation | undefined,
    raisedBy: ctx.actorContext.humanRef,
  });
  ctx.events.broadcast({ type: 'finding.changed' });
  return jsonResponse(finding, 201);
}

// PATCH /api/findings/:id — reopening or clearing a finding. Parking and
// blocking it are rulings and go through the adjudicate route instead.
export async function updateFinding(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { verdict?: unknown; ruling?: unknown };
  if (
    body.verdict !== undefined &&
    (typeof body.verdict !== 'string' ||
      !PATCHABLE_VERDICTS.includes(body.verdict))
  ) {
    return errorResponse(
      400,
      `invalid verdict: ${String(body.verdict)} (expected ${PATCHABLE_VERDICTS.join('|')}` +
        ` — park and block ${ADJUDICATED_ERROR})`
    );
  }
  if (
    body.ruling !== undefined &&
    body.ruling !== null &&
    typeof body.ruling !== 'string'
  ) {
    return errorResponse(400, 'invalid ruling: expected a string or null');
  }
  // Symmetrical to the check above: a standing ruling has task-level side
  // effects behind it, so an edit route must not clear one either.
  const existing = ctx.findingStore.get(id);
  if (existing === null) return errorResponse(404, `finding not found: ${id}`);
  if (ADJUDICATION_VERDICTS.includes(existing.verdict)) {
    return errorResponse(
      400,
      `finding ${id} carries a ${existing.verdict} ruling — change it ${ADJUDICATED_ERROR}`
    );
  }
  try {
    const finding = ctx.findingStore.update(id, {
      verdict: body.verdict as FindingVerdict | undefined,
      ruling: body.ruling,
    });
    ctx.events.broadcast({ type: 'finding.changed' });
    return jsonResponse(finding);
  } catch {
    return errorResponse(404, `finding not found: ${id}`);
  }
}

// GET /api/ledger?epicId= — omit epicId for every entry; pass it (including
// the empty string, rejected below) to see one epic's or the project-wide set.
export function listLedger(ctx: ApiContext, url: URL): Response {
  const hasFilter = url.searchParams.has('epicId');
  if (!hasFilter) return jsonResponse(ctx.ledgerStore.list());
  const epicId = url.searchParams.get('epicId');
  return jsonResponse(
    ctx.ledgerStore.list({ epicId: epicId === '' ? null : epicId })
  );
}

// Credits whoever actually authored the entry. `runId` is how
// record_decision (an MCP tool an agent can only call mid-run) says "this
// came from the run I'm in" — when it resolves, that run's own executor gets
// the credit, not the person operating this daemon. An unresolvable runId
// (stale, or made up) is credited to no one rather than guessed at, and a
// request with no runId at all is a human calling the endpoint directly.
function ledgerAuthorFor(ctx: ApiContext, runId: string | null): string {
  if (runId === null) return ctx.actorContext.humanRef;
  const run = ctx.orchestrator.getRun(runId);
  return run === null ? 'none' : ctx.actorContext.agentRef(run.meta.executor);
}

// POST /api/ledger — a decision or hazard worth carrying to later tasks.
export async function createLedgerEntry(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    epicId?: unknown;
    sourceTaskId?: unknown;
    kind?: unknown;
    title?: unknown;
    detail?: unknown;
    appliesTo?: unknown;
    runId?: unknown;
  };
  if (typeof body.kind !== 'string' || !LEDGER_KINDS.includes(body.kind)) {
    return errorResponse(
      400,
      `invalid kind: ${String(body.kind)} (expected ${LEDGER_KINDS.join('|')})`
    );
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  if (typeof body.detail !== 'string' || body.detail.trim() === '') {
    return errorResponse(400, 'invalid detail: detail is required');
  }
  if (
    body.appliesTo !== undefined &&
    (!Array.isArray(body.appliesTo) ||
      !body.appliesTo.every((v) => typeof v === 'string'))
  ) {
    return errorResponse(400, 'invalid appliesTo: expected a list of strings');
  }
  if (body.runId !== undefined && typeof body.runId !== 'string') {
    return errorResponse(400, 'invalid runId: expected a string');
  }
  const entry = ctx.ledgerStore.add({
    epicId: typeof body.epicId === 'string' ? body.epicId : null,
    sourceTaskId:
      typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null,
    kind: body.kind as LedgerKind,
    title: body.title,
    detail: body.detail,
    appliesTo: body.appliesTo,
    authoredBy: ledgerAuthorFor(
      ctx,
      typeof body.runId === 'string' ? body.runId : null
    ),
  });
  ctx.events.broadcast({ type: 'ledger.changed' });
  return jsonResponse(entry, 201);
}
