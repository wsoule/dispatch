import { createHash } from 'node:crypto';

import type { ApiContext } from '../api.js';
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

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string };

// The hex digest `agentByTokenHash` looks agents up by — sha256 of the raw
// token, matching how an agent's token is hashed at registration (task 6).
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Figures out who is calling a self-authenticating messaging route (POST
 * /api/messages and friends — see isSelfAuthenticated below), given the
 * bearer token it presented. Unlike the rest of the API, these routes never
 * accept the daemon's shared agentToken: every other route treats it as "the
 * operator, at request tier", but a message needs a real sender, and any
 * agent process holding that one on-disk token would otherwise be able to
 * speak as the operator. Checked first, ahead of the registry, so that
 * specific token gets its own explanatory error instead of "unknown token".
 *
 * The remaining three credential kinds are tried in turn: a human's daemon or
 * team token (the registry), a run's own minted token (proves it is that run,
 * nothing more), and finally a registered agent client's token (looked up by
 * hash, since only the hash is stored).
 */
export function resolvePrincipal(
  ctx: ApiContext,
  presented: string | null
): PrincipalResult {
  if (presented === null || presented === '') {
    return { ok: false, status: 401, error: 'unknown token' };
  }
  if (presented === ctx.tokens.agentToken) {
    return {
      ok: false,
      status: 403,
      error:
        "the shared agent token cannot send messages — use this run's DISPATCH_RUN_TOKEN, or register with POST /api/agents/register",
    };
  }
  const identity = ctx.tokens.registry.resolve(presented);
  if (identity !== null) {
    return {
      ok: true,
      principal: {
        address: identity.ref,
        canDecide: tierAllows(identity.tier, 'decide'),
        kind: 'human',
      },
    };
  }
  const runId = ctx.messaging.runTokens.verify(presented);
  if (runId !== null) {
    if (!ctx.orchestrator.isRunLive(runId)) {
      return { ok: false, status: 401, error: 'run token for a finished run' };
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
      return { ok: false, status: 403, error: 'awaiting approval in Dispatch' };
    }
    return {
      ok: false,
      status: 401,
      error: "this agent's access was revoked",
    };
  }
  return { ok: false, status: 401, error: 'unknown token' };
}

// Every messaging route that authenticates itself via resolvePrincipal rather
// than the daemon's request/decide/operator ladder (Task 6 implements the
// handlers; requiredTier in api.ts consults this to skip its own tier gate).
// `*` matches exactly one path segment — see matchesRoute's twin in api.ts.
const SELF_AUTHENTICATED_ROUTES: ReadonlyArray<{
  method: string;
  segments: readonly string[];
}> = [
  { method: 'POST', segments: ['messages'] },
  { method: 'GET', segments: ['messages', '*'] },
  { method: 'POST', segments: ['messages', '*', 'reply'] },
  { method: 'GET', segments: ['messages', '*', 'answer'] },
  { method: 'GET', segments: ['threads', '*'] },
  { method: 'GET', segments: ['inbox'] },
  { method: 'POST', segments: ['deliveries', '*', 'read'] },
  { method: 'GET', segments: ['channels'] },
  { method: 'POST', segments: ['channels', '*', 'members'] },
  { method: 'DELETE', segments: ['channels', '*', 'members', '*'] },
  { method: 'GET', segments: ['decisions', 'open'] },
];

/**
 * Whether `/api/<segments>` is one of the messaging routes above, which take
 * no daemon-tier token at all — only a principal resolvePrincipal can name.
 * `POST /api/agents/register` and `GET /api/agents` stay off this list on
 * purpose (they use the normal request tier), and so do the agent
 * approve/revoke/mute/unmute routes (they need the `decide` tier instead —
 * see ELEVATED_ROUTES in api.ts).
 */
export function isSelfAuthenticated(
  segments: readonly string[],
  method: string
): boolean {
  return SELF_AUTHENTICATED_ROUTES.some(
    (route) =>
      route.method === method &&
      route.segments.length === segments.length &&
      route.segments.every((part, i) => part === '*' || part === segments[i])
  );
}
