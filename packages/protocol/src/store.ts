import type { Address } from './address.js';
import type { Message, MessageKind } from './envelope.js';

export type DeliveryState =
  | 'held'
  | 'sending'
  | 'pushed'
  | 'notified'
  | 'read'
  | 'answered';
export const DELIVERY_STATES: readonly DeliveryState[] = [
  'held',
  'sending',
  'pushed',
  'notified',
  'read',
  'answered',
];

export type DeliveryVia = 'direct' | 'channel';

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
  insertMessage(message: Message, idemKey?: string): void;
  insertDelivery(delivery: Delivery): void;
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
  /** Answered gate questions (closes excluded) whose host effect is not yet recorded. */
  unappliedAnsweredGates(): { question: Message; answer: Message }[];
  countFrom(from: Address, sinceIso: string, urgentOnly: boolean): number;
  countAgentAuthored(
    threadId: string,
    sinceIso: string,
    exclude: Address
  ): number;
  ensureChannel(name: string, at: string, auto: boolean): void;
  channels(): ChannelRecord[];
  addMember(channel: string, member: Address, at: string): void;
  removeMember(channel: string, member: Address): boolean;
  members(channel: string): Address[];
  channelsOf(member: Address): string[];
  putAgent(agent: AgentRecord): void;
  getAgent(address: Address): AgentRecord | null;
  agentByTokenHash(hash: string): AgentRecord | null;
  agents(): AgentRecord[];
}
