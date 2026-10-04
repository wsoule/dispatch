import type { Address } from './address.js';
import { DELIVERY_STATES } from './constants.js';
import type { Message, MessageKind } from './envelope.js';

export { DELIVERY_STATES };
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export type DeliveryVia = 'direct' | 'channel';

/** How a federated thread settled an answer; superseded and candidate rows are stored as `message`. */
export type SettledAs = 'pending' | 'accepted' | 'superseded' | 'candidate';

/** A recipient homed on another replica: the furthest state its homes report. */
export type RemoteState =
  | 'forwarded'
  | 'held'
  | 'pushed'
  | 'notified'
  | 'read'
  | 'answered'
  | 'refused';
export const REMOTE_STATES: readonly RemoteState[] = [
  'forwarded',
  'held',
  'pushed',
  'notified',
  'read',
  'answered',
  'refused',
];

export interface RemoteDelivery {
  messageId: string;
  recipient: Address;
  via: DeliveryVia;
  state: RemoteState;
  /** The replicas placement chose for this recipient. */
  homes: string[];
  /** The one home that runs a wake request for a task recipient. */
  wakeAt: string | null;
  refusedBy: string[];
  updatedAt: string;
}

/** A question's outcome as its settler recorded it: an answer or a close reason. */
export interface Settlement {
  questionId: string;
  answerId: string | null;
  closedReason: string | null;
  settler: string;
  at: string;
}

/** Per-row facts that are not part of the message itself. */
export interface StoredMeta {
  /** Local arrival time of a remote message; quotas count by it. */
  receivedAt?: string;
  settledAs?: SettledAs;
}

export interface Delivery {
  id: string;
  messageId: string;
  recipient: Address;
  runId: string | null;
  via: DeliveryVia;
  state: DeliveryState;
  updatedAt: string;
}

export type AgentStatus = 'pending' | 'approved' | 'revoked';

export interface AgentRecord {
  address: Address;
  displayName: string;
  client: string;
  tokenHash: string;
  status: AgentStatus;
  muted: boolean;
  approvedBy: string | null;
  createdAt: string;
}

export interface ChannelRecord {
  name: string;
  createdAt: string;
  auto: boolean;
}

/** One thread's most recent state: its opening message, its latest message
 *  (the same one when a thread has only one message), and how many it holds. */
export interface ThreadSummary {
  thread: string;
  root: Message;
  last: Message;
  count: number;
}

export interface DeliveryFilter {
  recipient?: Address;
  states?: DeliveryState[];
  runId?: string;
  messageId?: string;
  /** Matches recipients starting with this prefix, e.g. `run:`. */
  recipientPrefix?: string;
}

export interface MessageStore {
  transaction<T>(fn: () => T): T;
  /** `idemKey` is the sender's dedupe key, unique per sender when set. */
  insertMessage(message: Message, idemKey?: string, meta?: StoredMeta): void;
  insertDelivery(delivery: Delivery): void;
  /** Removes one local delivery row; returns whether it existed. */
  deleteDelivery(id: string): boolean;
  getMessage(id: string): Message | null;
  /** The message `from` sent under `key`, or null. */
  byIdemKey(from: Address, key: string): Message | null;
  /** Each given message's dedupe key; keyless and unknown ids are left out. */
  idemKeysFor(messageIds: string[]): Map<string, string>;
  /** What `address` sent at or after `sinceIso`, oldest first, optionally only these kinds. */
  messagesFrom(
    address: Address,
    sinceIso: string,
    kinds?: MessageKind[]
  ): Message[];
  thread(threadId: string): Message[];
  answersTo(messageId: string): Message[];
  openBlocking(): Message[];
  getDelivery(id: string): Delivery | null;
  deliveries(filter: DeliveryFilter): Delivery[];
  /** With `expected`, updates only if the row is still in that state; returns whether it changed. */
  setDelivery(
    id: string,
    state: DeliveryState,
    runId: string | null,
    at: string,
    expected?: DeliveryState
  ): boolean;
  markGateApplied(questionId: string, at: string): void;
  /** Turns an answer back into a message and records it voided, which reopens its question. */
  voidAnswer(answerId: string, questionId: string, at: string): boolean;
  /** Answered gate questions (closes excluded) whose host effect is not yet recorded. */
  unappliedAnsweredGates(): { question: Message; answer: Message }[];
  /** Messages from `from` that arrived at or after `sinceIso`, and not after
   *  `untilIso` when given; `origin` narrows to one replica's. */
  countFrom(
    from: Address,
    sinceIso: string,
    urgentOnly: boolean,
    origin?: string,
    untilIso?: string
  ): number;
  /** Messages created in [sinceIso, untilIso] with a delivery to `recipient`; the per-peer quota. */
  countDeliveredTo(
    recipient: Address,
    sinceIso: string,
    untilIso?: string
  ): number;
  /** Agent-authored messages in a thread by arrival; a remote `exclude` still counts. */
  countAgentAuthored(
    threadId: string,
    sinceIso: string,
    exclude: Address
  ): number;
  /** The row's settled state, or null when unset or the message is unknown. */
  settledAs(messageId: string): SettledAs | null;
  /** Rewrites a reply's stored kind and settled state together. */
  setSettled(
    messageId: string,
    kind: 'answer' | 'message',
    settledAs: SettledAs | null
  ): void;
  /** Replies to a question that are or were answers, in arrival order. */
  answerCandidates(
    questionId: string
  ): { message: Message; settledAs: SettledAs | null }[];
  /** Adds a remote recipient's row; returns false when one already exists. */
  insertRemote(row: RemoteDelivery): boolean;
  /** Remote recipient rows matching every given field. */
  remoteDeliveries(filter: {
    messageId?: string;
    recipient?: Address;
    states?: RemoteState[];
  }): RemoteDelivery[];
  /** With `expected`, updates only if the row is still in that state; returns whether it changed. */
  setRemote(
    messageId: string,
    recipient: Address,
    patch: { state?: RemoteState; refusedBy?: string[]; homes?: string[] },
    at: string,
    expected?: RemoteState
  ): boolean;
  /** Removes a remote recipient's row; returns whether it existed. */
  deleteRemote(messageId: string, recipient: Address): boolean;
  /** A question's recorded settlement, or null. */
  settlement(questionId: string): Settlement | null;
  /** Records or replaces a question's settlement. */
  putSettlement(settlement: Settlement): void;
  /** Keeps a settle for a question not stored yet, one per publisher; never read as a settlement. */
  putEarlySettlement(settlement: Settlement): void;
  /** The early settles kept for a question, one per publisher. */
  earlySettlements(questionId: string): Settlement[];
  /** Drops a question's early settles once it has been stored. */
  clearEarlySettlements(questionId: string): void;
  /** Messages created here after `rowid`, oldest first; remote rows are skipped. */
  messagesAfter(
    rowid: number,
    limit: number
  ): { rowid: number; message: Message }[];
  /** The highest message rowid, or 0 for an empty store. */
  maxRowid(): number;
  ensureChannel(name: string, at: string, auto: boolean): void;
  channels(): ChannelRecord[];
  /** Adds a member; false when it was already in the channel. */
  addMember(channel: string, member: Address, at: string): boolean;
  removeMember(channel: string, member: Address): boolean;
  members(channel: string): Address[];
  channelsOf(member: Address): string[];
  putAgent(agent: AgentRecord): void;
  getAgent(address: Address): AgentRecord | null;
  agentByTokenHash(hash: string): AgentRecord | null;
  agents(): AgentRecord[];
}
