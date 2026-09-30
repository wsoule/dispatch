import { untrustedInline } from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import { cutUtf8, MEMORY_LIMITS } from '@dispatch/memory';
import type { SaveInput, SaveResult } from '@dispatch/memory';

import type { ApiContext } from '../api.js';
import { routePrincipal } from './caller.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The team constraint an amendment carries forward: it reaches the amended
// task's dependents, else its epic, else the whole project.
function amendmentConstraint(
  ctx: ApiContext,
  task: TaskDoc,
  body: { overrides: string; reason: string; source: string | null }
): SaveInput {
  const id = task.meta.id;
  const dependents = ctx.store
    .listSafe()
    .docs.filter((t) => t.meta.blockedBy.includes(id))
    .map((t) => t.meta.id)
    .slice(0, MEMORY_LIMITS.appliesTo);
  const detail = `${task.meta.title}: ${body.overrides} — ${body.reason}`;
  // An index shows titles alone, so the title states the override itself.
  const override = body.overrides.trim().split(/\r?\n/)[0] ?? '';
  return {
    scope: 'team',
    kind: 'constraint',
    title: cutUtf8(
      untrustedInline(`Amended ${id}: ${override}`),
      MEMORY_LIMITS.titleBytes
    ),
    body: cutUtf8(
      body.source === null ? detail : `${detail} (source: ${body.source})`,
      MEMORY_LIMITS.bodyBytes
    ),
    refs: [{ type: 'task', id }],
    epic: dependents.length === 0 ? task.meta.parent : null,
    appliesTo: dependents,
    origin: `amendment:${id}@${new Date().toISOString()}`,
  };
}

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

  // Through the memory write policy: a deciding human writes it, anyone else
  // (the shared agentToken included) proposes it.
  let memory: SaveResult | null = null;
  try {
    const content = amendmentConstraint(ctx, task, {
      overrides: body.overrides,
      reason: body.reason,
      source,
    });
    memory = await ctx.memory
      .requireEngine()
      .save(routePrincipal(ctx), content);
  } catch (err) {
    // The amendment itself stands; only its carried-forward constraint is lost.
    console.error(`dispatchd: amendment ${id} could not reach memory`, err);
  }

  ctx.events.broadcast({ type: 'task.changed' });
  return jsonResponse({ ...updated, memory });
}
