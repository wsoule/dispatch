import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// POST /api/tasks/:id/verify — dispatch a verify run against `head`, or skip
// (200) when the project has no `verify` config.
export async function startTaskVerification(
  req: Request,
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { head?: unknown };
  if (typeof body.head !== 'string' || body.head.trim() === '') {
    return errorResponse(400, 'invalid head: head is required');
  }
  const result = await ctx.verificationRunner.startVerification({
    taskId,
    head: body.head,
  });
  if (result.skipped) {
    return jsonResponse({ skipped: true, reason: result.reason });
  }
  return jsonResponse(result.meta, 202);
}

// GET /api/tasks/:id/verification — the most recent verify run's result.
export function getTaskVerification(ctx: ApiContext, taskId: string): Response {
  const result = ctx.verificationRunner.getLatestResult(taskId);
  return result !== null
    ? jsonResponse(result)
    : errorResponse(404, `no verification result for task: ${taskId}`);
}
