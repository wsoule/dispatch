import type { Address } from './address.js';
import type { Message } from './envelope.js';

export type PolicyRuling = 'allow' | 'ask' | 'deny';
export interface PolicyRequest {
  type: 'wake';
  target: Address;
  message: Message;
}
export type WakeResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

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
}
