import type { AuthMode, AuthResult } from '@dispatch-foo/a2a';
import { isClientAddress } from '@dispatch-foo/a2a';
import type { AgentRecord } from '@dispatch-foo/protocol';
import { createHash } from 'node:crypto';

// The one messages.db read these checks need: an agent row by token hash.
export interface AgentTokens {
  agentByTokenHash(hash: string): AgentRecord | null;
}

// The sha256 hex digest an agent's token is stored as at registration.
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const UNKNOWN: AuthResult = {
  ok: false,
  status: 401,
  reason: 'AUTH_INVALID_TOKEN',
  message: 'unknown token',
};

// The listener's bearer path: an approved a2a.* agent whose clients row still
// authenticates by bearer. A row that signs (P5) refuses a bearer outright.
// Every other bearer gets the same 401, so none can be confirmed as valid.
export function authenticateA2AClient(
  agents: AgentTokens,
  clientAuthOf: (address: string) => AuthMode | null,
  bearer: string
): AuthResult {
  const agent = agents.agentByTokenHash(tokenHash(bearer));
  if (agent === null || !isClientAddress(agent.address)) return UNKNOWN;
  if (agent.status === 'revoked') {
    return {
      ok: false,
      status: 401,
      reason: 'AUTH_AGENT_REVOKED',
      message: "this client's access was revoked",
    };
  }
  if (agent.status === 'pending') {
    return {
      ok: false,
      status: 403,
      reason: 'AUTH_AGENT_PENDING',
      message: 'awaiting approval in Dispatch',
    };
  }
  if (clientAuthOf(agent.address) !== 'bearer') return UNKNOWN;
  return {
    ok: true,
    caller: {
      address: agent.address,
      name: agent.address.slice(agent.address.indexOf('/') + 1),
    },
  };
}

// A client that proved its pinned key: allowed while its agent is approved
// and its row still authenticates by signature.
export function authenticateSignedAgent(
  agent: AgentRecord | null,
  auth: AuthMode | null,
  // 'link' only from a teammate link's own delivery path (T54).
  expected: 'signature' | 'link' = 'signature'
): AuthResult {
  if (agent === null || !isClientAddress(agent.address) || auth !== expected)
    return UNKNOWN;
  if (agent.status === 'revoked')
    return {
      ok: false,
      status: 401,
      reason: 'AUTH_AGENT_REVOKED',
      message: "this client's access was revoked",
    };
  if (agent.status === 'pending')
    return {
      ok: false,
      status: 403,
      reason: 'AUTH_AGENT_PENDING',
      message: 'awaiting approval in Dispatch',
    };
  return {
    ok: true,
    caller: {
      address: agent.address,
      name: agent.address.slice(agent.address.indexOf('/') + 1),
    },
  };
}

// Whether a bearer belongs to an A2A client, read from messages.db alone.
export function isA2AClientToken(
  agents: AgentTokens,
  presented: string
): boolean {
  const agent = agents.agentByTokenHash(tokenHash(presented));
  return agent !== null && isClientAddress(agent.address);
}
