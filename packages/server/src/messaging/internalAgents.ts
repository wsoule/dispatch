import type { AgentRecord } from '@dispatch/protocol';

// Every internal agent's token hash starts with this; no sha256 hex digest
// does, so no presented token can match one.
export const INTERNAL_TOKEN_PREFIX = 'internal:';

// An agent Dispatch runs itself, such as the overseer; registration never
// replaces its record.
export function isInternalAgent(agent: AgentRecord): boolean {
  return agent.tokenHash.startsWith(INTERNAL_TOKEN_PREFIX);
}
