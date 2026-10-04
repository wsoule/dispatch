import type { ApiContext } from '../api.js';
import type { Principal } from '../messaging/principal.js';
import { actingOperator } from '../orchestrator/types.js';
import { tierAllows } from '../tiers.js';

/** The actor the shared agentToken is credited as (XH-R2): an agent of the
 *  daemon's own, never the owner whose handle the token resolves to. */
const AGENT_TOKEN_ACTOR = 'agent:dispatch';

/**
 * The human whose namespace this credential speaks in: whoever presented it,
 * the owner for the shared agentToken, falling back to the operator for a
 * context built without one (the few internal callers that reach handlers
 * directly). Never use it to credit a write; that is requestActor.
 *
 * Its own module, importing only types and the import-free tiers module, so
 * the route modules under api/ can call it without a value-level import cycle
 * back into api.ts.
 */
export function humanActor(
  ctx: Pick<ApiContext, 'caller' | 'actorContext'>
): string {
  return ctx.caller?.ref ?? ctx.actorContext.humanRef;
}

/** Who a write is credited to: the credential's own human, or
 *  AGENT_TOKEN_ACTOR for the shared agentToken, which no human stands behind. */
export function requestActor(
  ctx: Pick<ApiContext, 'caller' | 'actorContext' | 'viaAgentToken'>
): string {
  if (ctx.viaAgentToken === true || ctx.caller?.agentToken === true)
    return AGENT_TOKEN_ACTOR;
  return humanActor(ctx);
}

/** The human behind this request's own credential; null for the shared
 *  agentToken, which no human stands behind. */
export function humanCredentialRef(
  ctx: Pick<ApiContext, 'caller' | 'viaAgentToken'>
): string | null {
  if (ctx.viaAgentToken === true || ctx.caller === undefined) return null;
  return ctx.caller.ref;
}

/** Who a run this request starts acts for: the credential's own human, the
 *  owner only on the owner's app token; no one for the shared agentToken. */
export function humanOperator(
  ctx: Pick<
    ApiContext,
    'caller' | 'viaAgentToken' | 'ownerCredential' | 'actorContext'
  >
): string | null {
  const ref = humanCredentialRef(ctx);
  return ref === null
    ? null
    : actingOperator(
        ref,
        ctx.ownerCredential === true,
        ctx.actorContext.humanRef
      );
}

/** A memory principal for a route outside messaging: a human, or an
 *  agent-trust writer attributed as requestActor. */
export function routePrincipal(ctx: ApiContext): Principal {
  if (ctx.viaAgentToken === true || ctx.caller === undefined)
    return { address: requestActor(ctx), canDecide: false, kind: 'agent' };
  return {
    address: ctx.caller.ref,
    canDecide: tierAllows(ctx.caller.tier, 'decide'),
    kind: 'human',
  };
}
