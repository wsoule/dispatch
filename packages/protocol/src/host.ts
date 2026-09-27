import type { Address } from './address.js';
import type { Sender } from './engine.js';
import type { Message } from './envelope.js';
import type { DeliveryVia } from './store.js';

export type PolicyRuling = 'allow' | 'ask' | 'deny';
export interface PolicyRequest {
  type: 'wake';
  target: Address;
  message: Message;
}
export type WakeResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

/** An address outside the machine: an A2A client of this project, or a peer agent. */
export type ExternalKind = 'client' | 'peer';
export type ExternalAdmission = 'deliver' | 'skip';
/** One external recipient of a send, with the caller's `to[i]` for errors. */
export interface ExternalTarget {
  recipient: Address;
  via: DeliveryVia;
  field: string;
}

// Everything the engine needs from the product that embeds it; dispatchd is one implementation.
export interface MessagingHost {
  liveRunFor(taskId: string): string | null;
  isLiveRun(runId: string): boolean;
  taskOfRun(runId: string): string | null;
  push(runId: string, rendered: string, message: Message): Promise<void>;
  notify(runId: string, digest: string, message: Message): Promise<void>;
  notifyHuman(actor: Address, message: Message): void;
  wake(target: Address, message: Message): Promise<WakeResult>;
  decide(request: PolicyRequest): PolicyRuling;
  owner(target: Address): Address;
  implicitMembers(channel: string): Address[];
  // May be called again for the same answer after a crash; handlers must be idempotent.
  onAnswered(question: Message, answer: Message): Promise<void>;
  now(): Date;
  // Classifies an address as external; a host without externals omits both hooks.
  external?(address: Address): ExternalKind | null;
  // Throws MessagingError to refuse. A refused channel-expanded target is skipped.
  admitExternal?(
    target: ExternalTarget,
    sender: Sender,
    replyTarget: Message | null,
    message: Message
  ): ExternalAdmission;
}
