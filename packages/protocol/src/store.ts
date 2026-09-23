import type { Address } from './address.js';
import type { Message } from './envelope.js';

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

export interface DeliveryFilter {
  recipient?: Address;
  states?: DeliveryState[];
  runId?: string;
  messageId?: string;
}

export interface MessageStore {
  transaction<T>(fn: () => T): T;
  insertMessage(message: Message): void;
  insertDelivery(delivery: Delivery): void;
  getMessage(id: string): Message | null;
  thread(threadId: string): Message[];
  answersTo(messageId: string): Message[];
  openBlocking(): Message[];
  getDelivery(id: string): Delivery | null;
  deliveries(filter: DeliveryFilter): Delivery[];
  setDelivery(
    id: string,
    state: DeliveryState,
    runId: string | null,
    at: string
  ): void;
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
