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

/** Changes only when something `threadLookups` reads does: a task's title, a
 *  run's task, an agent's status or mute. */
export function lookupsKey(
  tasks: readonly { meta: { id: string; title: string } }[],
  runs: readonly { id: string; taskId: string }[],
  agents: readonly AgentSummary[]
): string {
  return JSON.stringify([
    tasks.map((t) => [t.meta.id, t.meta.title]),
    runs.map((r) => [r.id, r.taskId]),
    agents.map((a) => [a.address, a.status, a.muted]),
  ]);
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

/** Where a tool call waits for its answer: a run, or an Assistant conversation. */
export type ParkedCall =
  | { runId: string; requestId: string }
  | { conversation: string; requestId: string };

export type RowControl =
  | { kind: 'none' }
  | { kind: 'read-only'; reason: string }
  | {
      kind: 'tool-approval';
      tool: string;
      input: unknown;
      truncated: boolean;
      /** The parked call, which a truncated preview reads in full; null when the gate names none. */
      call: ParkedCall | null;
    }
  | { kind: 'scope'; paths: string[]; reason: string }
  | { kind: 'choices'; choices: string[]; gate: boolean };

// The run or Assistant conversation a tool-approval gate's call is parked on.
function parkedCall(gate: {
  requestId: string;
  runId?: string;
  conversation?: string;
}): ParkedCall | null {
  const { requestId, runId, conversation } = gate;
  if (runId !== undefined) return { runId, requestId };
  if (conversation !== undefined) return { conversation, requestId };
  return null;
}

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
      return {
        kind: 'tool-approval',
        tool: gate.tool,
        input: gate.input,
        truncated: gate.truncated === true,
        call: parkedCall(gate),
      };
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

/** Whether some open message in a thread gives this viewer buttons (or a
 *  gate card) to answer it with, as `MessageRow` renders its control. */
export function hasAnswerButtons(
  messages: readonly Message[],
  ctx: { me: string; openIds: ReadonlySet<string>; access: MessageAccess }
): boolean {
  return messages.some((message) => {
    if (!ctx.openIds.has(message.id)) return false;
    const { me, access } = ctx;
    const control = rowControl(message, { me, open: true, access });
    if (control.kind === 'choices') return control.choices.length > 0;
    return control.kind === 'tool-approval' || control.kind === 'scope';
  });
}

/** `reply` answers an open question; `send` writes a plain message beside `replyTo`. */
export type ReplyPlan =
  | { kind: 'reply'; target: Message }
  | { kind: 'send'; to: string[]; replyTo: string };

/** How a typed reply in an open thread is addressed; null when there is nothing to reply to. */
export function replyPlan(
  messages: readonly Message[],
  me: string,
  openIds: ReadonlySet<string>
): ReplyPlan | null {
  const channel = messages[0]?.to.find((address) =>
    address.startsWith('channel:')
  );
  const newestFirst = [...messages].reverse();
  const answered = answeredIds(messages);
  // Text answers an open question put to me, whatever was said after it.
  const ask =
    channel === undefined
      ? newestFirst.find((m) => asksMe(m, me, openIds, answered))
      : undefined;
  if (ask !== undefined) return { kind: 'reply', target: ask };
  const target = newestFirst.find(
    (m) => m.from !== SYSTEM && !(openIds.has(m.id) && gateOf(m) !== null)
  );
  if (target === undefined) return null;
  if (channel !== undefined) {
    return { kind: 'send', to: [channel], replyTo: target.id };
  }
  // Text to anyone else is a plain message a retry can key, including beside
  // a handoff (answered only by accept or decline) or someone else's question.
  if (target.from !== me) {
    return { kind: 'send', to: [target.from], replyTo: target.id };
  }
  // The daemon reads no mail, so an answered gate of its own leaves no one to write to.
  const to = target.to.filter(
    (address) => address !== me && address !== SYSTEM
  );
  if (to.length === 0) return null;
  // Reply to the newest message they sent me, or else my own; either way the
  // daemon reroutes a party that is an ended run to its task.
  const theirs = [...messages].reverse().filter((m) => to.includes(m.from));
  const anchor = theirs.find((m) => m.to.includes(me)) ?? theirs[0] ?? target;
  return { kind: 'send', to, replyTo: anchor.id };
}

/** The ids a thread's rows treat as open: `openIds`, plus each unanswered
 *  non-blocking question put to me, which its choices or typed text answer. */
export function threadOpenIds(
  messages: readonly Message[],
  me: string,
  openIds: ReadonlySet<string>
): ReadonlySet<string> {
  const answered = answeredIds(messages);
  const asks = messages.filter(
    (m) => !openIds.has(m.id) && asksMe(m, me, openIds, answered)
  );
  if (asks.length === 0) return openIds;
  return new Set([...openIds, ...asks.map((m) => m.id)]);
}

// The ids of the questions and handoffs this thread already holds an answer to.
function answeredIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'answer' && m.replyTo !== null) ids.add(m.replyTo);
  }
  return ids;
}

// Whether `m` is a plain question put to me that still takes an answer: a
// blocking one while it is listed open, any other until it is answered.
function asksMe(
  m: Message,
  me: string,
  openIds: ReadonlySet<string>,
  answered: ReadonlySet<string>
): boolean {
  if (m.kind !== 'question' || m.from === me || m.from === SYSTEM) return false;
  if (!m.to.includes(me) || gateOf(m) !== null || answered.has(m.id)) {
    return false;
  }
  return !m.blocking || openIds.has(m.id);
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
