import type { ApiContext } from '../api.js';
import type { FixLoopVerdict } from '../orchestrator/fixLoop.js';
import { ADJUDICATION_VERDICTS, capError } from '../orchestrator/fixLoop.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from './http.js';

// GET /api/tasks/:id/fix-loop — the state plus its derived findings trace.
export function getFixLoop(ctx: ApiContext, taskId: string): Response {
  const state = ctx.fixLoop.getWithTrace(taskId);
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
    if (body.cap !== undefined) {
      const problem = capError(body.cap);
      if (problem !== null) return errorResponse(400, problem);
    }
    // `start` re-checks both, and resolves `baseSha` against the repository:
    // a base that names no commit fails every round from inside a dispatch.
    ctx.fixLoop.start(taskId, {
      baseSha: body.baseSha.trim(),
      cap: body.cap as number | undefined,
    });
  }
  return jsonResponse(await ctx.fixLoop.advance(taskId));
}

// POST /api/tasks/:id/fix-loop/start — the task view's "Review & fix" button.
// Takes no body: the server derives the base from the task's own implementer,
// which is the only thing that knows where the work forked from.
export async function startFixLoop(
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  return jsonResponse(await ctx.fixLoop.ignite(taskId));
}

// POST /api/tasks/:id/fix-loop/stop — the user's Stop button: caps the loop
// where it stands and asks the task's live runs to wind down.
export function stopFixLoop(ctx: ApiContext, taskId: string): Response {
  return jsonResponse(ctx.fixLoop.stop(taskId));
}

// GET /api/fix-loops — every task's loop state (with findings traces), for
// feeds that annotate rows.
export function listFixLoops(ctx: ApiContext): Response {
  return jsonResponse(ctx.fixLoop.listWithTrace());
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
