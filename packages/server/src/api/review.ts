import { describeValue } from '@dispatch/core';

import type { ApiContext } from '../api.js';
import type { ReviewScope } from '../orchestrator/review.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';
import { refusePrHeadRef } from './prHead.js';

// Declared as `readonly string[]` so a membership check against an
// unvalidated `unknown` never needs an `as` cast.
const SCOPES: readonly string[] = ['full', 'fix'];

// POST /api/tasks/:id/review — dispatch a review run over base..head. Open
// findings come from the store, never from the caller.
export async function startTaskReview(
  req: Request,
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    base?: unknown;
    head?: unknown;
    scope?: unknown;
    round?: unknown;
    extraRisks?: unknown;
    runId?: unknown;
  };
  // `base` deliberately gets no PR-head check. A PR review run's baseBranch
  // *is* that ref (orchestrator.ts `baseBranch: opts.head`), and ReviewView
  // sends it back as `base` to review the reviewer — refusing it breaks that.
  // Reading a diff is also weaker than `head`, which gets checked out.
  if (typeof body.base !== 'string' || body.base.trim() === '') {
    return errorResponse(400, 'invalid base: base is required');
  }
  if (typeof body.head !== 'string' || body.head.trim() === '') {
    return errorResponse(400, 'invalid head: head is required');
  }
  const refusedHead = refusePrHeadRef(body.head);
  if (refusedHead !== null) return refusedHead;
  if (body.scope !== undefined && !SCOPES.includes(body.scope as string)) {
    return errorResponse(
      400,
      `invalid scope: ${describeValue(body.scope)} (expected ${SCOPES.join('|')})`
    );
  }
  if (
    body.round !== undefined &&
    (typeof body.round !== 'number' || !Number.isInteger(body.round))
  ) {
    return errorResponse(400, 'invalid round: expected an integer');
  }
  if (
    body.extraRisks !== undefined &&
    (!Array.isArray(body.extraRisks) ||
      !body.extraRisks.every((v) => typeof v === 'string'))
  ) {
    return errorResponse(400, 'invalid extraRisks: expected a list of strings');
  }
  if (body.runId !== undefined && typeof body.runId !== 'string') {
    return errorResponse(400, 'invalid runId: expected a string');
  }
  const meta = await ctx.reviewRunner.startReview({
    taskId,
    base: body.base,
    head: body.head,
    round: typeof body.round === 'number' ? body.round : 0,
    scope: (body.scope as ReviewScope | undefined) ?? 'full',
    openFindings: ctx.findingStore.openFor(taskId),
    extraRisks: body.extraRisks,
    runId: body.runId,
  });
  return jsonResponse(meta, 202);
}

// GET /api/tasks/:id/findings
export function listTaskFindings(ctx: ApiContext, taskId: string): Response {
  return jsonResponse(ctx.findingStore.list({ taskId }));
}
