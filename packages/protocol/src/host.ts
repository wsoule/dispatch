import type { Address } from './address.js';
import type { Sender } from './engine.js';
import type { Message } from './envelope.js';
import type { DeliveryVia } from './store.js';

export type PolicyRuling = 'allow' | 'ask' | 'deny';
export interface PolicyRequest {
  type: 'wake';
  target: Address;
  message: Message;
  /** The replica a remote message came from; absent for one sent here. */
  origin?: string;
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

/** A recipient homed on other replicas: where it lives and who may wake it. */
export interface RemoteTarget {
  recipient: Address;
  via: DeliveryVia;
  homes: string[];
  wakeAt?: string;
}

/** A received message's source replica and its resolved targets, which receivers never re-expand. */
export interface RemoteOrigin {
  replica: string;
  targets: RemoteTarget[];
  /** Set on a forward: the one target it carries the message to this replica for. */
  forwardTarget?: Address;
}

/** Where one target of a local send lives: here, on other replicas, or nowhere it may go. */
export type Placement =
  | { kind: 'local' }
  | { kind: 'remote'; homes: string[]; alsoLocal: boolean; wakeAt?: string }
  | { kind: 'refuse'; reason: string };

// What the engine asks of a federating host; a host that does not federate omits them.
export interface FederationHooks {
  /** This replica's id, compared with a placement's `wakeAt`. */
  readonly replica: string;
  /** A persisted tick of the ledger clock, stamped on every message sent here. */
  hlc(): string;
  placement(
    target: { recipient: Address; via: DeliveryVia },
    message: Message,
    replyTarget: Message | null
  ): Placement;
  /** The task of a run live on another replica, from its presence, or null. */
  remoteRunTask(runId: string): string | null;
  /** A replica's roster handle, for "(remote: <handle>)". */
  label(replica: string): string;
  /** Records a problem the engine found in federated data. */
  problem(subject: string, message: string): void;
}

/** A remote home's report of one recipient's delivery state. */
export type DeliveryEntry = {
  t: 'delivery';
  message: string;
  recipient: Address;
  state: 'held' | 'pushed' | 'notified' | 'read' | 'answered';
  at: string;
};
/** A remote home refused a message for every recipient it holds. */
export type RefusedEntry = {
  t: 'refused';
  message: string;
  reason: string;
  at: string;
};
/** A question's settler recording its accepted answer, or its close. */
export type SettleEntry = {
  t: 'settle';
  question: string;
  answer: string;
  closed?: string;
  at: string;
};
export type StateEntry = DeliveryEntry | RefusedEntry;

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
  // Present only on a federating host; without it nothing is placed remotely.
  federation?: FederationHooks;
}
