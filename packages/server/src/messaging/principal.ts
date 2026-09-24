import { createHash, timingSafeEqual } from 'node:crypto';

import type { ApiContext } from '../api.js';
import { expiredTokenMessage, sha256 } from '../identity.js';
import { tierAllows } from '../tiers.js';

// Who is speaking to a self-authenticating messaging route: a human on the
// team, a live run acting on its own task, or a registered agent client.
// `canDecide` is what a gate reply checks — only a human at the `decide` tier
// or above may resolve a gate question (see resolvePrincipal below).
export interface Principal {
  address: string;
  canDecide: boolean;
  kind: 'human' | 'run' | 'agent';
}

// `code` mirrors the daemon-tier ladder's own auth codes (auth_missing_token,
// auth_token_expired, seat_limit, …) so a client can branch on messaging auth
// failures the same way it already does on every other route.
export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string; code: string };

// The hex digest `agentByTokenHash` looks agents up by — sha256 of the raw
// token, matching how an agent's token is hashed at registration (task 6).
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Figures out who is calling a self-authenticating messaging route (POST
 * /api/messages and friends — see isSelfAuthenticated in api.ts), given the
 * bearer token it presented. Unlike the rest of the API, these routes never
 * accept the daemon's shared agentToken: every other route treats it as "the
 * operator, at request tier", but a message needs a real sender, and any
 * agent process holding that one on-disk token would otherwise be able to
 * speak as the operator. Checked first, ahead of the registry, so that
 * specific token gets its own explanatory error instead of "unknown token".
 *
 * The remaining three credential kinds are tried in turn: a human's daemon or
 * team token (the registry — `lookup`, not `resolve`, so an expired or
 * seat-refused teammate token keeps its specific error instead of collapsing
 * to "unknown token"), a run's own minted token (proves it is that run,
 * nothing more), and finally a registered agent client's token (looked up by
 * hash, since only the hash is stored).
 */
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
  // Constant-time comparison on the sha256 digest, never the raw strings —
  // same defence identity.ts's own token comparisons use, so a caller can't
  // learn anything about the real agentToken from response timing.
  if (timingSafeEqual(sha256(presented), sha256(ctx.tokens.agentToken))) {
    return {
      ok: false,
      status: 403,
      error:
        "the shared agent token cannot send messages — use this run's DISPATCH_RUN_TOKEN, or register with POST /api/agents/register",
      code: 'auth_agent_token_forbidden',
    };
  }
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
