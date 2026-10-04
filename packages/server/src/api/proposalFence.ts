import type { ApiContext } from '../api.js';
import { tierAllows } from '../tiers.js';
import { errorResponse } from './http.js';

/** A human credential at the decide tier; never the shared agent token. */
export function decidingHuman(
  ctx: Pick<ApiContext, 'caller' | 'viaAgentToken'>
): boolean {
  return (
    ctx.viaAgentToken !== true &&
    ctx.caller !== undefined &&
    tierAllows(ctx.caller.tier, 'decide')
  );
}

// The task writes an open A2A proposal fences (XH-R5): the task itself, and
// its amendments, comments and attachments.
const FENCED = new Set(['amend', 'comment', 'comments', 'attachments']);

/** 409 for a write below the decide tier to a task whose A2A proposal is
 *  still open; null when the write may go ahead. */
export function proposalWriteRefusal(
  ctx: Pick<ApiContext, 'a2a' | 'caller' | 'viaAgentToken'>,
  method: string,
  segments: readonly string[]
): Response | null {
  if (method === 'GET' || method === 'HEAD' || segments[0] !== 'tasks')
    return null;
  if (segments.length < 2) return null;
  if (segments.length > 2 && !FENCED.has(segments[2])) return null;
  const taskId = segments[1];
  if (ctx.a2a === undefined || decidingHuman(ctx)) return null;
  if (!ctx.a2a.proposalOpen(taskId)) return null;
  return errorResponse(
    409,
    `${taskId} is an A2A proposal awaiting the owner; only a deciding human may change it until it is answered`
  );
}
