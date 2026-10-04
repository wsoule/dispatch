import type { TaskDoc } from '@dispatch/core';

import type { ApiContext } from '../api.js';
import {
  FanoutError,
  fanoutLabel,
  parseVariants,
  validateVariants,
  variantTaskInput,
} from '../fanout.js';
import type { RunMeta } from '../orchestrator/types.js';
import { humanOperator } from './caller.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';
import { decidingHuman } from './proposalFence.js';

/**
 * `POST /api/tasks/:id/fanout` — run the same work on several agents at once.
 *
 * Each variant becomes its own task and its own run, because the orchestrator
 * allows one live run per task and that invariant is load-bearing (see
 * ../fanout.ts). Comparing the results is then just the review the app already
 * does, one diff per variant.
 */

type FanoutRouteContext = Pick<
  ApiContext,
  | 'store'
  | 'cache'
  | 'events'
  | 'orchestrator'
  | 'caller'
  | 'viaAgentToken'
  | 'ownerCredential'
  | 'actorContext'
  | 'a2a'
>;

interface FanoutResult {
  sourceTaskId: string;
  label: string;
  variants: {
    executor: string;
    model?: string;
    task: TaskDoc;
    run: RunMeta | null;
    /** Why this variant has no run, when dispatching it failed. */
    error?: string;
  }[];
}

export async function fanoutTask(
  req: Request,
  ctx: FanoutRouteContext,
  taskId: string
): Promise<Response> {
  const source = ctx.store.get(taskId);
  if (source === null) return errorResponse(404, `task not found: ${taskId}`);
  // Clones of a gated draft would run its client-written text; the dispatch
  // guard alone sees only the clones.
  if (ctx.a2a?.proposalOpen(taskId) === true) {
    return errorResponse(
      409,
      `${taskId} is an A2A proposal awaiting the owner; answer it in Needs you`
    );
  }

  // Clones run the client's text: only a deciding human fans one out.
  const a2a = ctx.a2a?.taskOrigin(taskId) === 'a2a';
  if (a2a && !decidingHuman(ctx))
    return errorResponse(
      403,
      `${taskId} came in over A2A; fanning it out needs the decide tier`
    );

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { variants?: unknown };

  let variants;
  try {
    variants = parseVariants(body.variants);
    validateVariants(variants, ctx.orchestrator.registeredExecutorNames());
  } catch (err) {
    if (err instanceof FanoutError) return errorResponse(400, err.message);
    throw err;
  }

  const result: FanoutResult = {
    sourceTaskId: taskId,
    label: fanoutLabel(taskId),
    variants: [],
  };

  for (const variant of variants) {
    const task = ctx.store.create(variantTaskInput(source, variant));
    // Before dispatch, so the clone's run gets an A2A task's fences.
    if (a2a) ctx.a2a?.markDerived(task.meta.id, taskId);
    // Refreshed per variant rather than once at the end: `dispatch` reads the
    // task back through the store, and a cache that has not caught up would
    // make the second variant fail to find the task the first just created.
    ctx.cache.refresh(ctx.store, [task.meta.id]);
    try {
      const run = await ctx.orchestrator.dispatch(
        task.meta.id,
        variant.executor,
        {
          ...(variant.model === undefined ? {} : { model: variant.model }),
          // Each variant acts for whoever the caller's credential names, as a
          // dispatch does.
          operator: humanOperator(ctx),
        }
      );
      result.variants.push({
        executor: variant.executor,
        ...(variant.model === undefined ? {} : { model: variant.model }),
        task,
        run,
      });
    } catch (err) {
      // One variant failing to start — an executor that refuses the project's
      // permission mode, a spend ceiling reached — must not abandon the ones
      // that did start. The task stays, carrying the reason, so the caller can
      // see which agent did not run and why.
      result.variants.push({
        executor: variant.executor,
        ...(variant.model === undefined ? {} : { model: variant.model }),
        task,
        run: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ids = result.variants.map((v) => v.task.meta.id);
  ctx.cache.refresh(ctx.store, ids);
  ctx.events.broadcast({ type: 'task.changed', ids });
  ctx.events.broadcast({ type: 'run.changed' });
  return jsonResponse(result, 201);
}
