import type { ApiContext } from '../api.js';
import type { Principal } from '../messaging/principal.js';
import { actingOperator } from '../orchestrator/types.js';
import { tierAllows } from '../tiers.js';

/** The actor the shared agentToken is credited as (XH-R2, amended): never the
 *  owner whose handle the token resolves to, and never agent:dispatch, the
 *  messaging system address that system-keyed checks trust. */
const AGENT_TOKEN_ACTOR = 'agent:local-cli';

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

/** Who a write is credited to: the run whose own token made it (`runActor`),
 *  the credential's own human, or AGENT_TOKEN_ACTOR for the shared agentToken,
 *  which no human stands behind. */
export function requestActor(
  ctx: Pick<
    ApiContext,
    'caller' | 'actorContext' | 'viaAgentToken' | 'runActor'
  >
): string {
  if (ctx.runActor !== undefined) return ctx.runActor;
  if (ctx.viaAgentToken === true || ctx.caller?.agentToken === true)
    return AGENT_TOKEN_ACTOR;
  return humanActor(ctx);
}

/** The actor a run's own token writes as: `agent:<operator handle>/<run id>`,
 *  or `agent:run/<run id>` for a run that acts for no one. Never the owner,
 *  the CLI's actor or the messaging system address. */
export function runActorFor(
  runId: string,
  operator: string | null | undefined
): string {
  const handle =
    operator?.startsWith('human:') === true
      ? operator.slice('human:'.length)
      : 'run';
  return `agent:${handle}/${runId}`;
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

/** A memory principal for a route outside messaging: a human, the run whose
 *  own token made the request, or an agent-trust writer as requestActor. */
export function routePrincipal(ctx: ApiContext): Principal {
  // A run's own token is that run, with its operator and A2A rules.
  if (ctx.viaRun !== undefined)
    return { address: `run:${ctx.viaRun}`, canDecide: false, kind: 'run' };
  if (ctx.viaAgentToken === true || ctx.caller === undefined)
    return { address: requestActor(ctx), canDecide: false, kind: 'agent' };
  return {
    address: ctx.caller.ref,
    canDecide: tierAllows(ctx.caller.tier, 'decide'),
    kind: 'human',
  };
}
