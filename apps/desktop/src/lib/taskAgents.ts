import type { Message } from '@dispatch/client';

import { isA2AAddress } from './a2a';

/** One outside (A2A) agent a task has traded messages with, and where things stand. */
export interface TaskAgentParty {
  /** `a2a:<alias>` for a peer, `agent:<handle>/a2a.<name>` for a client. */
  address: string;
  /** The short name shown in the rail. */
  label: string;
  /** Questions this agent asked that nobody here has answered yet. */
  waitingOnYou: number;
  /** Questions sent to this agent that it has not answered yet. */
  waitingOnThem: number;
  handoffsIn: number;
  handoffsOut: number;
  messages: number;
  lastAt: string;
}

/** `a2a:acme` → `acme`; `agent:wyat/a2a.ci-bot` → `ci-bot`. */
export function agentLabel(address: string): string {
  if (address.startsWith('a2a:')) return address.slice('a2a:'.length);
  const dot = address.indexOf('/a2a.');
  return dot === -1 ? address : address.slice(dot + '/a2a.'.length);
}

function emptyParty(address: string): TaskAgentParty {
  return {
    address,
    label: agentLabel(address),
    waitingOnYou: 0,
    waitingOnThem: 0,
    handoffsIn: 0,
    handoffsOut: 0,
    messages: 0,
    lastAt: '',
  };
}

/**
 * Groups a task's conversation by the outside agents in it, for the task rail's "Outside
 * agents" section. A message counts toward an agent when that agent sent it or is one of
 * its recipients. A question is open until some message in the conversation replies to
 * it. Agents someone has to act on come first: waiting on you, then waiting on them, then
 * the most recent.
 */
export function taskAgentParties(
  messages: readonly Message[]
): TaskAgentParty[] {
  const replied = new Set<string>();
  for (const m of messages) if (m.replyTo !== null) replied.add(m.replyTo);

  const parties = new Map<string, TaskAgentParty>();
  const partyFor = (address: string) => {
    let party = parties.get(address);
    if (party === undefined) {
      party = emptyParty(address);
      parties.set(address, party);
    }
    return party;
  };

  for (const m of messages) {
    const open = m.kind === 'question' && !replied.has(m.id);
    if (isA2AAddress(m.from)) {
      const party = partyFor(m.from);
      party.messages += 1;
      if (open) party.waitingOnYou += 1;
      if (m.kind === 'handoff') party.handoffsIn += 1;
      if (m.createdAt > party.lastAt) party.lastAt = m.createdAt;
      continue;
    }
    for (const to of new Set(m.to)) {
      if (!isA2AAddress(to)) continue;
      const party = partyFor(to);
      party.messages += 1;
      if (open) party.waitingOnThem += 1;
      if (m.kind === 'handoff') party.handoffsOut += 1;
      if (m.createdAt > party.lastAt) party.lastAt = m.createdAt;
    }
  }

  return [...parties.values()].sort(
    (a, b) =>
      b.waitingOnYou - a.waitingOnYou ||
      b.waitingOnThem - a.waitingOnThem ||
      (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0)
  );
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The one line under an agent's name: what's waiting first, else what happened. */
export function partySummary(party: TaskAgentParty): string {
  if (party.waitingOnYou > 0) {
    return `Waiting on you · ${plural(party.waitingOnYou, 'question', 'questions')}`;
  }
  if (party.waitingOnThem > 0) {
    return `Waiting on them · ${plural(party.waitingOnThem, 'question', 'questions')}`;
  }
  const parts: string[] = [];
  if (party.handoffsIn > 0) {
    parts.push(plural(party.handoffsIn, 'handoff in', 'handoffs in'));
  }
  if (party.handoffsOut > 0) {
    parts.push(plural(party.handoffsOut, 'handoff out', 'handoffs out'));
  }
  if (parts.length === 0) {
    parts.push(plural(party.messages, 'message', 'messages'));
  }
  return parts.join(' · ');
}
