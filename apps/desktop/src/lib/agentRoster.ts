import type { AgentStatus, AgentSummary, Message } from '@dispatch/client';

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

/** The roster query (`GET /api/agents/roster`), shared so other surfaces can refresh it. */
export function agentRosterKey(
  port: number | undefined
): readonly ['dispatch-agent-roster', number | undefined] {
  return ['dispatch-agent-roster', port] as const;
}

interface RosterActions {
  approve: boolean;
  mute: boolean;
  revoke: boolean;
}

/** The owner's own Overseer, `agent:<owner>/overseer`, named only for a
 *  window holding the owner's app token: re-approving it is their off switch. */
export function ownerOverseer(
  me: string | null,
  ownerCredential: boolean
): string | null {
  if (me === null || !ownerCredential) return null;
  return `agent:${handleOf(me)}/overseer`;
}

/** What a roster row offers. A revoked agent's token is dead and it returns
 *  only by registering again, so its row offers nothing (XH-R3); the one
 *  exception is `overseer`, the owner's revoked Overseer, which Approve
 *  brings back. */
export function rosterActions(
  agent: AgentSummary,
  overseer: string | null = null
): RosterActions {
  const live = agent.status !== 'revoked';
  const approve =
    agent.status === 'pending' || (!live && agent.address === overseer);
  return { approve, mute: live, revoke: live };
}

/** The agents a decider muted: their messages stay readable but never ask for attention. */
export function mutedAddresses(
  agents: readonly AgentSummary[]
): ReadonlySet<string> {
  return new Set(agents.filter((a) => a.muted).map((a) => a.address));
}

/** An address without its kind: `human:wyat` → `wyat`. */
export function handleOf(address: string): string {
  const colon = address.indexOf(':');
  return colon === -1 ? address : address.slice(colon + 1);
}

/** Whether a new message may have changed the roster: a registration gate adds
 *  a pending agent, and any answer may be the one that settles such a gate. */
export function mayChangeAgentRoster(message: Message): boolean {
  if (message.kind === 'answer') return true;
  const data = message.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'agent-registration'
  );
}
