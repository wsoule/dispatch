import type { ApiContext } from '../api.js';
import type { Principal } from '../messaging/principal.js';
import { tierAllows } from '../tiers.js';

/**
 * The human a write should be credited to: whoever presented the credential,
 * falling back to the operator for a context built without one (the few
 * internal callers that reach handlers directly).
 *
 * This is what makes attribution trustworthy on a shared daemon. Before
 * tokens named people every human write was credited to the operator,
 * because the operator was the only human there could be; a teammate's
 * comment would have read as the operator's.
 *
 * Its own module, importing only types and the import-free tiers module, so
 * the route modules under api/ can call it without a value-level import cycle
 * back into api.ts.
 */
export function humanActor(ctx: ApiContext): string {
  return ctx.caller?.ref ?? ctx.actorContext.humanRef;
}

/** The human behind this request's own credential; null for the shared
 *  agentToken, which humanActor credits to the owner. */
export function humanCredentialRef(
  ctx: Pick<ApiContext, 'caller' | 'viaAgentToken'>
): string | null {
  if (ctx.viaAgentToken === true || ctx.caller === undefined) return null;
  return ctx.caller.ref;
}

/** A memory principal for a route outside messaging: a human, or an
 *  agent-trust writer attributed as humanActor. */
export function routePrincipal(ctx: ApiContext): Principal {
  if (ctx.viaAgentToken === true || ctx.caller === undefined)
    return { address: humanActor(ctx), canDecide: false, kind: 'agent' };
  return {
    address: ctx.caller.ref,
    canDecide: tierAllows(ctx.caller.tier, 'decide'),
    kind: 'human',
  };
}
