import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// POST /api/tasks/:id/amend — records a correction to a task's spec: what
// changes, why, and (optionally) where the correction came from.
export async function amendTask(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const task = ctx.store.get(id);
  if (task === null) return errorResponse(404, `task not found: ${id}`);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    overrides?: unknown;
    reason?: unknown;
    source?: unknown;
  };
  if (typeof body.overrides !== 'string' || body.overrides.trim() === '') {
    return errorResponse(400, 'invalid overrides: overrides is required');
  }
  // An amendment without a stated reason is the same silent-discard failure
  // the findings ledger exists to prevent, so it's rejected outright.
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return errorResponse(400, 'invalid reason: reason is required');
  }
  if (body.source !== undefined && typeof body.source !== 'string') {
    return errorResponse(400, 'invalid source: expected a string');
  }
  const source = typeof body.source === 'string' ? body.source : null;

  const updated = ctx.store.amend(id, {
    overrides: body.overrides,
    reason: body.reason,
    source,
  });
  ctx.cache.rebuild(ctx.store);

  // A dependent task inherits this as a constraint, the same channel a
  // review's findings carry forward through.
  ctx.ledgerStore.add({
    epicId: task.meta.parent,
    sourceTaskId: id,
    kind: 'constraint',
    title: `Amendment to ${task.meta.id}: ${task.meta.title}`,
    detail:
      source === null
        ? `${body.overrides} — ${body.reason}`
        : `${body.overrides} — ${body.reason} (source: ${source})`,
    authoredBy: ctx.actorContext.humanRef,
  });

  ctx.events.broadcast({ type: 'task.changed' });
  ctx.events.broadcast({ type: 'ledger.changed' });
  return jsonResponse(updated);
}
