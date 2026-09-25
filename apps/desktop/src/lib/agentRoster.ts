import type { AgentStatus, AgentSummary } from '@dispatch/client';

const STATUS_ORDER: Record<AgentStatus, number> = {
  pending: 0,
  approved: 1,
  revoked: 2,
};

/** The roster in the order someone works through it: pending first, since each
 *  waits on a decision, then approved, then revoked; newest first within each. */
export function sortRoster(agents: readonly AgentSummary[]): AgentSummary[] {
  return [...agents].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.createdAt.localeCompare(a.createdAt)
  );
}

interface RosterActions {
  approve: boolean;
  mute: boolean;
  revoke: boolean;
}

/** What a roster row offers. A revoked agent's token is dead and it returns
 *  only by registering again, so its row offers nothing. */
export function rosterActions(agent: AgentSummary): RosterActions {
  const live = agent.status !== 'revoked';
  return { approve: agent.status === 'pending', mute: live, revoke: live };
}

/** An address without its kind: `human:wyat` → `wyat`. */
export function handleOf(address: string): string {
  const colon = address.indexOf(':');
  return colon === -1 ? address : address.slice(colon + 1);
}
