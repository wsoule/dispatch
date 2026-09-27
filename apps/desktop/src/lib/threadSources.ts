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
  /** Whether an address is the daemon's own overseer (the Assistant). */
  isOverseer: (address: string) => boolean;
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
  // The daemon approves only its own agents; anyone may register a name.
  const overseer = agents.find(
    (a) => a.approvedBy === SYSTEM && OVERSEER.test(a.address)
  )?.address;
  return {
    taskTitle: (id) => titles.get(id) ?? null,
    taskIdOfRun: (id) => taskOfRun.get(id) ?? null,
    agentStatus: (address) => status.get(address) ?? null,
    // Until the roster loads, any overseer-named agent reads as the Assistant.
    isOverseer: (address) =>
      overseer === undefined ? OVERSEER.test(address) : address === overseer,
  };
}

/** Changes only when something `threadLookups` reads does: a task's title, a
 *  run's task, an agent's status, mute or approver. */
export function lookupsKey(
  tasks: readonly { meta: { id: string; title: string } }[],
  runs: readonly { id: string; taskId: string }[],
  agents: readonly AgentSummary[]
): string {
  return JSON.stringify([
    tasks.map((t) => [t.meta.id, t.meta.title]),
    runs.map((r) => [r.id, r.taskId]),
    agents.map((a) => [a.address, a.status, a.muted, a.approvedBy]),
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

const KIND_LABELS: Record<string, string> = {
  question: 'Question',
  handoff: 'Handoff',
  notice: 'Notice',
  answer: 'Answer',
};

/** The badge a message kind shows: a built-in kind's name, a custom `x-` kind
 *  as written, and none for a plain message. */
export function kindLabel(kind: string): string | undefined {
  return kind === 'message' ? undefined : (KIND_LABELS[kind] ?? kind);
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

/** A row control that draws something to answer with. */
type AnswerControl = Extract<
  RowControl,
  { kind: 'tool-approval' | 'scope' | 'choices' }
>;

/** Whether a row's control draws a gate card or at least one choice button:
 *  the one rule `MessageRow` renders by and the reply box's footer reads. */
export function offersAnswer(control: RowControl): control is AnswerControl {
  if (control.kind === 'choices') return control.choices.length > 0;
  return control.kind === 'tool-approval' || control.kind === 'scope';
}

/** Whether some open message in a thread gives this viewer buttons (or a
 *  gate card) to answer it with. */
export function hasAnswerButtons(
  messages: readonly Message[],
  ctx: { me: string; openIds: ReadonlySet<string>; access: MessageAccess }
): boolean {
  const { me, access } = ctx;
  return messages.some(
    (message) =>
      ctx.openIds.has(message.id) &&
      offersAnswer(rowControl(message, { me, open: true, access }))
  );
}

/** `reply` answers an open question; `send` writes a plain message beside `replyTo`. */
export type ReplyPlan =
  | { kind: 'reply'; target: Message }
  | { kind: 'send'; to: string[]; replyTo: string };

/** Who is replying: a deciding human may reply to any message; anyone else
 *  only to one they sent, were sent, or were delivered (`deliveries`). */
export interface Replier {
  canDecide: boolean;
  deliveries: readonly Delivery[];
}

const DECIDING: Replier = { canDecide: true, deliveries: [] };

/** How a typed reply in an open thread is addressed; null when there is nothing to reply to. */
export function replyPlan(
  messages: readonly Message[],
  me: string,
  openIds: ReadonlySet<string>,
  replier: Replier = DECIDING
): ReplyPlan | null {
  const channel = messages[0]?.to.find((address) =>
    address.startsWith('channel:')
  );
  const delivered = new Set(
    replier.deliveries.filter((d) => d.recipient === me).map((d) => d.messageId)
  );
  const tookPart = (m: Message): boolean =>
    replier.canDecide ||
    m.from === me ||
    m.to.includes(me) ||
    delivered.has(m.id);
  const newestFirst = [...messages].reverse().filter(tookPart);
  const answered = answeredIds(messages);
  // Text answers the newest open question put to me, unless I wrote since it.
  const ask =
    channel === undefined
      ? newestFirst.find((m) => m.from === me || asksMe(m, me, answered))
      : undefined;
  if (ask !== undefined && ask.from !== me) {
    return { kind: 'reply', target: ask };
  }
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
  // The daemon reroutes an ended run to its task only for the replied-to
  // message's writer, so reply to the newest message they sent me.
  const theirs = newestFirst.filter((m) => to.includes(m.from));
  const anchor = theirs.find((m) => m.to.includes(me)) ?? theirs[0] ?? target;
  return { kind: 'send', to, replyTo: anchor.id };
}

/** Where a typed reply goes, as the reply box names it. */
export function replyTarget(plan: ReplyPlan, lookups: ThreadLookups): string {
  if (plan.kind === 'reply') {
    return `Answering ${participantLabel(plan.target.from, lookups)}`;
  }
  const names = plan.to.map((address) => participantLabel(address, lookups));
  return `To ${names.join(', ')}`;
}

/** The ids a thread's rows treat as open: `openIds` less any the thread already
 *  answers (a list can lag an answer), plus each question put to me that it
 *  holds no answer to, which its choices or typed text answer. */
export function threadOpenIds(
  messages: readonly Message[],
  me: string,
  openIds: ReadonlySet<string>
): ReadonlySet<string> {
  const answered = answeredIds(messages);
  const asks = messages.filter(
    (m) => !openIds.has(m.id) && asksMe(m, me, answered)
  );
  const settled = [...answered].filter((id) => openIds.has(id));
  if (asks.length === 0 && settled.length === 0) return openIds;
  const ids = new Set([...openIds, ...asks.map((m) => m.id)]);
  for (const id of settled) ids.delete(id);
  return ids;
}

// The ids of the questions and handoffs this thread already holds an answer to.
function answeredIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'answer' && m.replyTo !== null) ids.add(m.replyTo);
  }
  return ids;
}

// Whether `m` is a plain question put to me that still takes an answer: one
// its thread holds no answer to, blocking or not.
function asksMe(
  m: Message,
  me: string,
  answered: ReadonlySet<string>
): boolean {
  if (m.kind !== 'question' || m.from === me || m.from === SYSTEM) return false;
  return m.to.includes(me) && gateOf(m) === null && !answered.has(m.id);
}

export type ReplyRoute = 'bus' | 'overseer' | 'overseer-elsewhere';

/** Where a reply goes: the bus, the live overseer conversation, or nowhere (an older one). */
export function replyRoute(
  messages: readonly Message[],
  thread: string,
  overseerThread: string | null,
  lookups: Pick<ThreadLookups, 'isOverseer'>
): ReplyRoute {
  const withOverseer = messages.some(
    (m) => lookups.isOverseer(m.from) || m.to.some(lookups.isOverseer)
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
