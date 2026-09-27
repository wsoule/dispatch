// Pure logic behind the Threads view: rail summaries and grouping, live
// appends to an open thread, and `@` address completion and labels.
import type {
  Delivery,
  DeliveryState,
  Message,
  ThreadSummary as RecentThread,
} from '@dispatch/client';

/** One rail row: a thread's ends and size, plus what it holds for `me`. */
export interface ThreadSummary extends RecentThread {
  /** My deliveries in the thread that are not yet read. */
  unread: number;
  /** An open gate, or an unanswered handoff, is waiting on me. */
  needsYou: boolean;
  /** The channel name the root was sent to; null for a direct thread. */
  channel: string | null;
  /** Everyone else who sent or received, first seen first; channels left out. */
  participants: string[];
}

export type RailGroup = 'needs-you' | 'channels' | 'direct';

export interface SummarizeOptions {
  /** Ids of tasks `me` owns: a handoff to one of them waits on me too. */
  myTaskIds?: ReadonlySet<string>;
  /** `GET /api/threads` rows, whose ends and counts cover messages not given. */
  recent?: readonly RecentThread[];
}

export interface KnownAddresses {
  tasks: { id: string; title: string }[];
  /** Channel names, with or without the `channel:` scheme. */
  channels: string[];
  /** Agent addresses; a bare `operator/name` gets the `agent:` scheme. */
  agents: string[];
  /** Human addresses; a bare handle gets the `human:` scheme. */
  humans: string[];
}

export interface AddressCompletion {
  address: string;
  label: string;
}

const UNREAD_STATES: ReadonlySet<DeliveryState> = new Set([
  'held',
  'notified',
  'pushed',
]);
const CHANNEL = 'channel:';

/** A delivery to `me` not read yet: what the rail counts and opening a thread marks read. */
export function isUnread(delivery: Delivery, me: string): boolean {
  return delivery.recipient === me && UNREAD_STATES.has(delivery.state);
}
const TASK = 'task:';
const NO_TASKS: ReadonlySet<string> = new Set();

// Message ids are ulids, so comparing ids orders messages by time.
function byIdAscending(a: Message, b: Message): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function newestFirst(a: ThreadSummary, b: ThreadSummary): number {
  return byIdAscending(b.last, a.last);
}

/**
 * Folds messages gathered from the mailbox, open decisions and thread fetches
 * into one summary per thread, newest last message first. Duplicates across
 * those sources count once; `openGateIds` are the open decisions' ids.
 */
export function summarizeThreads(
  messages: Message[],
  deliveries: Delivery[],
  me: string,
  openGateIds: ReadonlySet<string>,
  options: SummarizeOptions = {}
): ThreadSummary[] {
  const myTaskIds = options.myTaskIds ?? NO_TASKS;
  const recent = new Map<string, RecentThread>();
  const byId = new Map<string, Message>();
  for (const row of options.recent ?? []) {
    recent.set(row.thread, row);
    byId.set(row.root.id, row.root);
    byId.set(row.last.id, row.last);
  }
  for (const message of messages) byId.set(message.id, message);

  // A question or handoff closes on its answer, or once its deliveries say so.
  const answered = new Set<string>();
  for (const message of byId.values()) {
    if (message.kind === 'answer' && message.replyTo !== null) {
      answered.add(message.replyTo);
    }
  }
  const latestDeliveries = new Map<string, Delivery>();
  for (const d of deliveries) latestDeliveries.set(d.id, d);
  const unreadByMessage = new Map<string, number>();
  for (const d of latestDeliveries.values()) {
    if (d.state === 'answered') answered.add(d.messageId);
    if (isUnread(d, me)) {
      unreadByMessage.set(
        d.messageId,
        (unreadByMessage.get(d.messageId) ?? 0) + 1
      );
    }
  }

  const isMine = (address: string): boolean =>
    address === me ||
    (address.startsWith(TASK) && myTaskIds.has(address.slice(TASK.length)));
  const waitsOnMe = (message: Message): boolean => {
    if (answered.has(message.id)) return false;
    const openGate = openGateIds.has(message.id) && message.to.includes(me);
    const handoff = message.kind === 'handoff' && message.to.some(isMine);
    return openGate || handoff;
  };

  const byThread = new Map<string, Message[]>();
  for (const message of byId.values()) {
    const list = byThread.get(message.thread);
    if (list === undefined) byThread.set(message.thread, [message]);
    else list.push(message);
  }

  const summaries: ThreadSummary[] = [];
  for (const [thread, list] of byThread) {
    list.sort(byIdAscending);
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) continue;
    const root = byId.get(thread) ?? first;
    const server = recent.get(thread);
    const count =
      server === undefined
        ? list.length
        : server.count + list.filter((m) => m.id > server.last.id).length;

    let unread = 0;
    let needsYou = false;
    const participants = new Set<string>();
    for (const message of list) {
      unread += unreadByMessage.get(message.id) ?? 0;
      needsYou = needsYou || waitsOnMe(message);
      for (const address of [message.from, ...message.to]) {
        if (address !== me && !address.startsWith(CHANNEL)) {
          participants.add(address);
        }
      }
    }
    const channel = root.to.find((address) => address.startsWith(CHANNEL));
    summaries.push({
      thread,
      root,
      last,
      count,
      unread,
      needsYou,
      channel: channel === undefined ? null : channel.slice(CHANNEL.length),
      participants: [...participants],
    });
  }
  return summaries.sort(newestFirst);
}

/** Splits summaries into the rail's groups, in rail order, newest first in each. */
export function groupRail(
  summaries: ThreadSummary[]
): Record<RailGroup, ThreadSummary[]> {
  const rail: Record<RailGroup, ThreadSummary[]> = {
    'needs-you': [],
    channels: [],
    direct: [],
  };
  for (const summary of [...summaries].sort(newestFirst)) {
    if (summary.needsYou) rail['needs-you'].push(summary);
    else if (summary.channel !== null) rail.channels.push(summary);
    else rail.direct.push(summary);
  }
  return rail;
}

/**
 * Adds a live message to the open thread in id order. Returns `current` itself
 * when the message is already there or belongs to another thread.
 */
export function appendToThread(
  current: Message[],
  incoming: Message
): Message[] {
  const first = current[0];
  if (first !== undefined && first.thread !== incoming.thread) return current;
  // Scan back from the end, since a live message nearly always lands last.
  let at = current.length;
  for (; at > 0; at--) {
    const before = current[at - 1];
    if (before === undefined || before.id < incoming.id) break;
    if (before.id === incoming.id) return current;
  }
  return [...current.slice(0, at), incoming, ...current.slice(at)];
}

type CompletionKind = 'task' | 'channel' | 'agent' | 'human';

interface Candidate extends AddressCompletion {
  /** Lowercased text a query can match: a task's id and title, else the name. */
  keys: string[];
}

// Typed prefixes that narrow `@` completion to one kind of address.
const SCOPES: readonly [string, CompletionKind][] = [
  ['#', 'channel'],
  [CHANNEL, 'channel'],
  [TASK, 'task'],
  ['agent:', 'agent'],
  ['human:', 'human'],
];
const KIND_ORDER: readonly CompletionKind[] = [
  'task',
  'channel',
  'agent',
  'human',
];
const BARE_LIMIT = 5;
const SCOPED_LIMIT = 20;

function withScheme(scheme: string, value: string): string {
  return value.startsWith(scheme) ? value : `${scheme}${value}`;
}

function candidates(kind: CompletionKind, known: KnownAddresses): Candidate[] {
  const noTitles = { taskTitle: () => null };
  switch (kind) {
    case 'task':
      return known.tasks.map((task) => ({
        address: `${TASK}${task.id}`,
        label: addressLabel(`${TASK}${task.id}`, {
          taskTitle: () => task.title,
        }),
        keys: [task.id.toLowerCase(), task.title.toLowerCase()],
      }));
    case 'channel':
      return known.channels.map((raw) => {
        const address = withScheme(CHANNEL, raw);
        const name = address.slice(CHANNEL.length);
        return { address, label: `#${name}`, keys: [name.toLowerCase()] };
      });
    case 'agent':
    case 'human':
      return (kind === 'agent' ? known.agents : known.humans).map((raw) => {
        const address = withScheme(`${kind}:`, raw);
        const label = addressLabel(address, noTitles);
        return { address, label, keys: [label.toLowerCase()] };
      });
  }
}

// -1 when some key is the query, 0 when one starts with it, 1 when one only contains it.
function matchRank(keys: string[], query: string): number | null {
  if (query !== '' && keys.includes(query)) return -1;
  if (keys.some((key) => key.startsWith(query))) return 0;
  if (keys.some((key) => key.includes(query))) return 1;
  return null;
}

/**
 * Suggests addresses for what follows an `@`. `#`, `channel:`, `task:`,
 * `agent:` and `human:` narrow to that kind (twenty at most); anything else
 * searches all kinds, five at most of each. An id or name typed in full leads
 * every kind, then start-of-id or name matches.
 */
export function completeAddress(
  prefix: string,
  known: KnownAddresses
): AddressCompletion[] {
  const typed = (
    prefix.startsWith('@') ? prefix.slice(1) : prefix
  ).toLowerCase();
  const scope = SCOPES.find(([lead]) => typed.startsWith(lead));
  const kinds = scope === undefined ? KIND_ORDER : [scope[1]];
  const query = scope === undefined ? typed : typed.slice(scope[0].length);
  const limit = scope === undefined ? BARE_LIMIT : SCOPED_LIMIT;

  const exact: AddressCompletion[] = [];
  const rest: AddressCompletion[] = [];
  for (const kind of kinds) {
    const ranked: { candidate: Candidate; rank: number }[] = [];
    for (const candidate of candidates(kind, known)) {
      const rank = matchRank(candidate.keys, query);
      if (rank !== null) ranked.push({ candidate, rank });
    }
    // Array sort is stable, so equal ranks keep the order `known` gave.
    ranked.sort((a, b) => a.rank - b.rank);
    for (const { candidate, rank } of ranked.slice(0, limit)) {
      const { address, label } = candidate;
      (rank < 0 ? exact : rest).push({ address, label });
    }
  }
  return [...exact, ...rest];
}

/**
 * The short name an address shows as: `task:t-1` as `t-1 · Title`, a channel
 * as `#name`, actors and runs without their scheme, anything else as written.
 */
export function addressLabel(
  address: string,
  lookups: { taskTitle: (id: string) => string | null }
): string {
  const colon = address.indexOf(':');
  if (colon <= 0) return address;
  const rest = address.slice(colon + 1);
  switch (address.slice(0, colon)) {
    case 'task': {
      const title = lookups.taskTitle(rest);
      return title === null || title === '' ? rest : `${rest} · ${title}`;
    }
    case 'channel':
      return `#${rest}`;
    case 'human':
    case 'agent':
    case 'run':
      return rest;
    default:
      return address;
  }
}
