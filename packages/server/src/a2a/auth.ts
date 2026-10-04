import type { AuthResult } from '@dispatch/a2a';
import { isClientAddress } from '@dispatch/a2a';
import type { AgentRecord } from '@dispatch/protocol';
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

// The listener's only credential: an approved a2a.* agent with a clients row.
// Every other bearer gets the same 401, so none can be confirmed as valid.
export function authenticateA2AClient(
  agents: AgentTokens,
  hasClientRow: (address: string) => boolean,
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
  if (!hasClientRow(agent.address)) return UNKNOWN;
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
