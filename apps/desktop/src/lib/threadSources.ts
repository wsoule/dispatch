// Pure helpers the Threads surfaces share: merging the rail's sources, labels,
// what a row offers, how a reply is addressed, and where a ref leads.
import type {
  AgentSummary,
  ChannelSummary,
  Delivery,
  MailboxItem,
  Message,
  Ref,
} from '@dispatch/client';

import type { MessageAccess } from './daemonAuth';
import { gateOf } from './gates';
import type { KnownAddresses } from './threads';
import { addressLabel } from './threads';

const SYSTEM = 'agent:dispatch';
const OVERSEER = /^agent:[a-z0-9][a-z0-9._-]*\/overseer$/;
const TITLE_WIDTH = 80;

/** My mailbox's messages plus the open gates, my deliveries, and the ids of
 *  open things put to me. */
export function mergeThreadSources(
  src: { mailbox: readonly MailboxItem[]; openGates: readonly Message[] },
  me: string
): { messages: Message[]; deliveries: Delivery[]; openIds: Set<string> } {
  const byId = new Map<string, Message>();
  for (const { message } of src.mailbox) byId.set(message.id, message);
  for (const gate of src.openGates) byId.set(gate.id, gate);
  const openIds = new Set(src.openGates.map((gate) => gate.id));
  const deliveries: Delivery[] = [];
  for (const { delivery, message } of src.mailbox) {
    if (delivery.recipient !== me) continue;
    deliveries.push(delivery);
    // A teammate cannot list open decisions; their mailbox still says what waits on them.
    const asks =
      message.kind === 'handoff' ||
      (message.kind === 'question' && message.blocking);
    if (asks && delivery.state !== 'answered') openIds.add(message.id);
  }
  return { messages: [...byId.values()], deliveries, openIds };
}

/** What labels and refs need to know about the board, from data the view already has. */
export interface ThreadLookups {
  taskTitle: (taskId: string) => string | null;
  taskIdOfRun: (runId: string) => string | null;
  agentStatus: (address: string) => 'revoked' | 'muted' | null;
}

export function threadLookups(
  tasks: readonly { meta: { id: string; title: string } }[],
  runs: readonly { id: string; taskId: string }[],
  agents: readonly AgentSummary[]
): ThreadLookups {
  const titles = new Map(tasks.map((t) => [t.meta.id, t.meta.title]));
  const taskOfRun = new Map(runs.map((r) => [r.id, r.taskId]));
  const status = new Map<string, 'revoked' | 'muted'>();
  for (const agent of agents) {
    if (agent.status === 'revoked') status.set(agent.address, 'revoked');
    else if (agent.muted) status.set(agent.address, 'muted');
  }
  return {
    taskTitle: (id) => titles.get(id) ?? null,
    taskIdOfRun: (id) => taskOfRun.get(id) ?? null,
    agentStatus: (address) => status.get(address) ?? null,
  };
}

/** An address as a person reads it: a run as its task plus the run id, the daemon as Dispatch. */
export function participantLabel(
  address: string,
  lookups: ThreadLookups
): string {
  if (address === SYSTEM) return 'Dispatch';
  if (address.startsWith('run:')) {
    const runId = address.slice('run:'.length);
    const taskId = lookups.taskIdOfRun(runId);
    return taskId === null
      ? runId
      : `${addressLabel(`task:${taskId}`, lookups)} · ${runId}`;
  }
  return addressLabel(address, lookups);
}

/** A thread's one-line title: its root's first line, cut to 80 characters. */
export function threadTitle(root: Message): string {
  const first = Array.from(root.body.split('\n', 1)[0] ?? '');
  return first.length > TITLE_WIDTH
    ? `${first.slice(0, TITLE_WIDTH - 1).join('')}…`
    : first.join('');
}

/** What the composer completes: board tasks, channels, approved agents, and connected humans. */
export function knownAddresses(input: {
  tasks: readonly { meta: { id: string; title: string } }[];
  channels: readonly ChannelSummary[];
  agents: readonly AgentSummary[];
  presence: readonly { ref: string }[];
  me: string | null;
}): KnownAddresses {
  const humans = new Set<string>(input.me === null ? [] : [input.me]);
  for (const person of input.presence) humans.add(person.ref);
  return {
    tasks: input.tasks.map((t) => ({ id: t.meta.id, title: t.meta.title })),
    channels: input.channels.map((c) => c.name),
    agents: input.agents
      .filter((a) => a.status === 'approved')
      .map((a) => a.address),
    humans: [...humans],
  };
}

export type RowControl =
  | { kind: 'none' }
  | { kind: 'read-only'; reason: string }
  | { kind: 'tool-approval'; tool: string; input: unknown }
  | { kind: 'scope'; paths: string[]; reason: string }
  | { kind: 'choices'; choices: string[]; gate: boolean };

/** What a message row offers this viewer: a gate card, choice buttons, a
 *  read-only reason, or nothing. */
export function rowControl(
  message: Message,
  ctx: { me: string; open: boolean; access: MessageAccess }
): RowControl {
  if (!ctx.open) return { kind: 'none' };
  const gate = gateOf(message);
  if (gate !== null) {
    if (!ctx.access.canDecide) {
      return {
        kind: 'read-only',
        reason:
          ctx.access.explanation ?? 'Only a deciding human can answer this.',
      };
    }
    if (gate.type === 'tool-approval') {
      return { kind: 'tool-approval', tool: gate.tool, input: gate.input };
    }
    if (gate.type === 'scope') {
      return { kind: 'scope', paths: gate.paths, reason: gate.reason };
    }
    return { kind: 'choices', choices: message.choices ?? [], gate: true };
  }
  if (!message.to.includes(ctx.me)) return { kind: 'none' };
  if (!ctx.access.canMessage) {
    return { kind: 'read-only', reason: ctx.access.explanation ?? '' };
  }
  const fallback = message.kind === 'handoff' ? ['accept', 'decline'] : [];
  return { kind: 'choices', choices: message.choices ?? fallback, gate: false };
}

export type ReplyPlan =
  | { kind: 'reply'; target: Message }
  | { kind: 'send'; to: string[]; replyTo: string };

/** How a typed reply in an open thread is addressed; null when there is nothing to reply to. */
export function replyPlan(
  messages: readonly Message[],
  me: string,
  openIds: ReadonlySet<string>
): ReplyPlan | null {
  const target = [...messages]
    .reverse()
    .find(
      (m) => m.from !== SYSTEM && !(openIds.has(m.id) && gateOf(m) !== null)
    );
  if (target === undefined) return null;
  const channel = messages[0]?.to.find((address) =>
    address.startsWith('channel:')
  );
  if (channel !== undefined) {
    return { kind: 'send', to: [channel], replyTo: target.id };
  }
  const asks = target.kind === 'question' || target.kind === 'handoff';
  if (target.from !== me && (!asks || openIds.has(target.id))) {
    return { kind: 'reply', target };
  }
  const to =
    target.from !== me
      ? [target.from]
      : target.to.filter((address) => address !== me);
  return to.length === 0 ? null : { kind: 'send', to, replyTo: target.id };
}

export type ReplyRoute = 'bus' | 'overseer' | 'overseer-elsewhere';

/** Where a reply goes: the bus, the live overseer conversation, or nowhere (an older one). */
export function replyRoute(
  messages: readonly Message[],
  thread: string,
  overseerThread: string | null
): ReplyRoute {
  const withOverseer = messages.some(
    (m) =>
      OVERSEER.test(m.from) || m.to.some((address) => OVERSEER.test(address))
  );
  if (!withOverseer) return 'bus';
  return thread === overseerThread ? 'overseer' : 'overseer-elsewhere';
}

export type RefAction =
  | { kind: 'task'; taskId: string }
  | { kind: 'run'; taskId: string; runId: string }
  | { kind: 'file'; path: string }
  | { kind: 'message'; messageId: string };

/** Where a ref chip leads, or null for one with no page (a commit, a run no longer listed). */
export function refAction(
  ref: Ref,
  lookups: Pick<ThreadLookups, 'taskIdOfRun'>
): RefAction | null {
  switch (ref.type) {
    case 'task':
      return { kind: 'task', taskId: ref.id };
    case 'run': {
      const taskId = lookups.taskIdOfRun(ref.id);
      return taskId === null ? null : { kind: 'run', taskId, runId: ref.id };
    }
    case 'file':
      return { kind: 'file', path: ref.id };
    case 'message':
      return { kind: 'message', messageId: ref.id };
    default:
      return null;
  }
}

/** Where a sender's name leads: a run to its chat, a task to its page, anyone else nowhere. */
export function addressAction(
  address: string,
  lookups: Pick<ThreadLookups, 'taskIdOfRun'>
): RefAction | null {
  if (address.startsWith('run:')) {
    return refAction(
      { type: 'run', id: address.slice('run:'.length) },
      lookups
    );
  }
  if (address.startsWith('task:')) {
    return { kind: 'task', taskId: address.slice('task:'.length) };
  }
  return null;
}

/** The app's navigation verbs a ref needs. */
export interface RefNavigation {
  openTask: (taskId: string, tab: 'details' | 'chat', runId?: string) => void;
  openThread: (messageId: string) => void;
  openImpact: (subject: { kind: 'file'; id: string }) => void;
}

export function openRefWith(nav: RefNavigation): (action: RefAction) => void {
  return (action) => {
    if (action.kind === 'task') nav.openTask(action.taskId, 'details');
    else if (action.kind === 'run') {
      nav.openTask(action.taskId, 'chat', action.runId);
    } else if (action.kind === 'file') {
      nav.openImpact({ kind: 'file', id: action.path });
    } else nav.openThread(action.messageId);
  };
}
