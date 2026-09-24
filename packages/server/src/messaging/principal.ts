import { createHash, timingSafeEqual } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { expiredTokenMessage, sha256 } from '../identity.js';
import { tierAllows } from '../tiers.js';

// Who is calling a messaging route: a team human, a live run or a registered
// agent. Only `canDecide` (a human at decide tier or above) may answer a gate.
export interface Principal {
  address: string;
  canDecide: boolean;
  kind: 'human' | 'run' | 'agent';
}

// `code` reuses the tier ladder's auth codes (auth_missing_token, seat_limit,
// …) so a client branches on messaging auth failures as on any other route.
export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string; code: string };

// The hex digest `agentByTokenHash` looks agents up by — sha256 of the raw
// token, matching how an agent's token is hashed at registration.
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Resolves a messaging caller's token to a teammate, run or agent. The shared
 *  agentToken is refused, or any agent could send as the owner. */
export function resolvePrincipal(
  ctx: ApiContext,
  presented: string | null
): PrincipalResult {
  if (presented === null || presented === '') {
    return {
      ok: false,
      status: 401,
      error: 'unknown token',
      code: 'auth_missing_token',
    };
  }
  // Constant-time compare of sha256 digests, so response timing reveals
  // nothing about the real agentToken.
  if (timingSafeEqual(sha256(presented), sha256(ctx.tokens.agentToken))) {
    return {
      ok: false,
      status: 403,
      error:
        "the shared agent token cannot send messages — use this run's DISPATCH_RUN_TOKEN, or register with POST /api/agents/register",
      code: 'auth_agent_token_forbidden',
    };
  }
  // lookup, not resolve: an expired or seat-refused token keeps its own error.
  const lookup = ctx.tokens.registry.lookup(presented);
  if (lookup.kind === 'valid') {
    return {
      ok: true,
      principal: {
        address: lookup.identity.ref,
        canDecide: tierAllows(lookup.identity.tier, 'decide'),
        kind: 'human',
      },
    };
  }
  if (lookup.kind === 'expired') {
    return {
      ok: false,
      status: 401,
      error: expiredTokenMessage(lookup.handle, lookup.expiredAt),
      code: 'auth_token_expired',
    };
  }
  if (lookup.kind === 'refused') {
    return { ok: false, status: 403, error: lookup.reason, code: 'seat_limit' };
  }
  const runId = ctx.messaging.runTokens.verify(presented);
  if (runId !== null) {
    if (!ctx.orchestrator.isRunLive(runId)) {
      return {
        ok: false,
        status: 401,
        error: 'run token for a finished run',
        code: 'auth_run_token_ended',
      };
    }
    return {
      ok: true,
      principal: { address: `run:${runId}`, canDecide: false, kind: 'run' },
    };
  }
  const agent = ctx.messaging.store.agentByTokenHash(tokenHash(presented));
  if (agent !== null) {
    if (agent.status === 'approved') {
      return {
        ok: true,
        principal: {
          address: agent.address,
          canDecide: false,
          kind: 'agent',
        },
      };
    }
    if (agent.status === 'pending') {
      return {
        ok: false,
        status: 403,
        error: 'awaiting approval in Dispatch',
        code: 'auth_agent_pending',
      };
    }
    return {
      ok: false,
      status: 401,
      error: "this agent's access was revoked",
      code: 'auth_agent_revoked',
    };
  }
  return {
    ok: false,
    status: 401,
    error: 'unknown token',
    code: 'auth_invalid_token',
  };
}
