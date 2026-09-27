import { gateOf, MessagingError } from '@dispatch/protocol';
import type { Address, Delivery, JsonValue, Message } from '@dispatch/protocol';

export const CLIENT_NAME_PREFIX = 'a2a.';
const CLIENT_ADDRESS = /^agent:[^/]+\/a2a\./;

// Who an A2A client may address: listed humans and its approved handoffs' tasks.
export interface RecipientFacts {
  allowedHumans: readonly Address[];
  approvedTasks: ReadonlySet<string>;
}

// Whether a message to a client belongs to one of that client's tasks.
export interface ReachFacts {
  inClientScope: boolean;
  fromApprovedLinkedTask: boolean;
}

// A handoff's Dispatch task, whether its proposal was approved, and its runs.
export interface TaskLink {
  taskId: string;
  approved: boolean;
  runIds: ReadonlySet<string>;
}

export interface ScopeInput {
  root: Message;
  client: Address;
  candidates: readonly Message[];
  deliveries: ReadonlyMap<string, readonly Delivery[]>;
  link: TaskLink | null;
}

// The daemon's agent-name rule, kept here because this package owns the
// `a2a.` reservation.
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40);
}

export function clientNameFor(raw: string): string {
  return `${CLIENT_NAME_PREFIX}${normalizeName(raw).slice(0, 36)}`;
}

export function isReservedName(normalized: string): boolean {
  return normalized.startsWith(CLIENT_NAME_PREFIX);
}

export function isClientAddress(address: Address): boolean {
  return CLIENT_ADDRESS.test(address);
}

// A client may name listed humans and its approved handoffs' tasks; every
// other address gets the same refusal, so it cannot probe who exists.
export function checkInboundRecipients(
  to: readonly Address[],
  facts: RecipientFacts
): void {
  to.forEach((address, i) => {
    if (facts.allowedHumans.includes(address)) return;
    if (
      address.startsWith('task:') &&
      facts.approvedTasks.has(address.slice('task:'.length))
    )
      return;
    throw new MessagingError(
      'forbidden',
      `${address} is not reachable from this A2A client`,
      `to[${i}]`
    );
  });
}

// Mail reaches a client only inside its own tasks, and never with gate data.
export function checkReachClient(
  message: { data?: JsonValue },
  facts: ReachFacts,
  field: string
): void {
  if (gateOf(message) !== null) {
    throw new MessagingError(
      'forbidden',
      'gate data never goes to an A2A client',
      'data'
    );
  }
  if (facts.inClientScope || facts.fromApprovedLinkedTask) return;
  throw new MessagingError(
    'invalid',
    'A2A clients are reachable only inside their own tasks',
    field
  );
}

// The ids from `start` up its replyTo chain, stopping at a cycle, a missing
// message or `max` hops.
export function replyChain(
  start: Message,
  get: (id: string) => Message | null,
  max = 200
): string[] {
  const seen: string[] = [start.id];
  let next = start.replyTo;
  while (next !== null && seen.length < max && !seen.includes(next)) {
    seen.push(next);
    next = get(next)?.replyTo ?? null;
  }
  return seen;
}

function runOf(address: Address): string | null {
  return address.startsWith('run:') ? address.slice('run:'.length) : null;
}

// Traffic between the client and an approved handoff's task or its runs.
function linkedTraffic(
  m: Message,
  client: Address,
  link: TaskLink | null
): boolean {
  if (link === null || !link.approved) return false;
  const task = `task:${link.taskId}`;
  const run = runOf(m.from);
  const fromLinked = m.from === task || (run !== null && link.runIds.has(run));
  return (
    (m.from === client && m.to.includes(task)) ||
    (fromLinked && m.to.includes(client))
  );
}

// A task's scope: messages related to it and visible to the client, gates
// excluded, oldest first.
export function scopeOf(input: ScopeInput): Message[] {
  const byId = new Map(input.candidates.map((m) => [m.id, m] as const));
  byId.set(input.root.id, input.root);
  const get = (id: string) => byId.get(id) ?? null;
  const related = (m: Message) =>
    replyChain(m, get).includes(input.root.id) ||
    linkedTraffic(m, input.client, input.link);
  const visible = (m: Message) =>
    m.from === input.client ||
    (input.deliveries.get(m.id) ?? []).some(
      (d) => d.recipient === input.client
    );
  return [...byId.values()]
    .filter((m) => gateOf(m) === null && related(m) && visible(m))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Whether an open gate holds this A2A task: its own proposal gate, or a
// tool, scope or wake gate for the linked task and its runs.
export function gateInScope(
  question: Message,
  proposalGateId: string | null,
  link: TaskLink | null
): boolean {
  const gate = gateOf(question);
  if (gate === null) return false;
  if (question.id === proposalGateId) return true;
  if (link === null) return false;
  switch (gate.type) {
    case 'tool-approval':
      return gate.runId !== undefined && link.runIds.has(gate.runId);
    case 'scope': {
      const run = runOf(question.from);
      return run !== null && link.runIds.has(run);
    }
    case 'wake':
      return gate.target === `task:${link.taskId}`;
    default:
      return false;
  }
}
