import type { ApiContext } from '../api.js';
import type { FixLoopVerdict } from '../orchestrator/fixLoop.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from './http.js';

// Declared as `readonly string[]` so a membership check against an
// unvalidated `unknown` never needs an `as` cast.
const ADJUDICATION_VERDICTS: readonly string[] = ['parked', 'blocked'];

// GET /api/tasks/:id/fix-loop
export function getFixLoop(ctx: ApiContext, taskId: string): Response {
  const state = ctx.fixLoop.get(taskId);
  return state === null
    ? errorResponse(404, `no fix loop for task: ${taskId}`)
    : jsonResponse(state);
}

// POST /api/tasks/:id/fix-loop/advance — `baseSha` opens the loop on the first
// call and is ignored afterwards; the base is fixed for the whole loop.
export async function advanceFixLoop(
  req: Request,
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { baseSha?: unknown; cap?: unknown };
  if (ctx.fixLoop.get(taskId) === null) {
    if (typeof body.baseSha !== 'string' || body.baseSha.trim() === '') {
      return errorResponse(
        400,
        'invalid baseSha: baseSha is required to open a fix loop'
      );
    }
    if (
      body.cap !== undefined &&
      (typeof body.cap !== 'number' ||
        !Number.isInteger(body.cap) ||
        body.cap < 1)
    ) {
      return errorResponse(400, 'invalid cap: expected an integer >= 1');
    }
    ctx.fixLoop.start(taskId, {
      baseSha: body.baseSha.trim(),
      cap: body.cap,
    });
  }
  return jsonResponse(await ctx.fixLoop.advance(taskId));
}

// POST /api/tasks/:id/findings/:fid/adjudicate — the ruling the cap demands.
// Advancing afterwards is what lets a fully-parked cap settle to `complete`.
export async function adjudicateFinding(
  req: Request,
  ctx: ApiContext,
  taskId: string,
  findingId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { verdict?: unknown; ruling?: unknown };
  if (
    typeof body.verdict !== 'string' ||
    !ADJUDICATION_VERDICTS.includes(body.verdict)
  ) {
    return errorResponse(
      400,
      `invalid verdict: ${String(body.verdict)} (expected ${ADJUDICATION_VERDICTS.join('|')})`
    );
  }
  if (typeof body.ruling !== 'string' || body.ruling.trim() === '') {
    return errorResponse(
      400,
      'invalid ruling: a ruling is required — parking a finding without a' +
        ' stated reason is a silent discard'
    );
  }
  const finding = ctx.fixLoop.adjudicate(
    taskId,
    findingId,
    body.verdict as FixLoopVerdict,
    body.ruling
  );
  const loop =
    ctx.fixLoop.get(taskId) === null ? null : await ctx.fixLoop.advance(taskId);
  return jsonResponse({ finding, fixLoop: loop });
}
