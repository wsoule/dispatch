import type { Address } from '../address.js';
import type { JsonValue, Message } from '../envelope.js';
import type { DeliveryVia } from '../store.js';
import { sha256Hex } from './encoding.js';
import { canonicalize } from './jcs.js';

export type OpType =
  | 'key'
  | 'roster'
  | 'task'
  | 'presence'
  | 'agent'
  | 'channel'
  | 'mail'
  | 'state'
  | 'memory'
  | 'doc';

export const OP_TYPES: readonly OpType[] = [
  'key',
  'roster',
  'task',
  'presence',
  'agent',
  'channel',
  'mail',
  'state',
  'memory',
  'doc',
];

// Only mail and state travel sealed; every other type is board state in the clear.
export const SEALED_TYPES: ReadonlySet<string> = new Set(['mail', 'state']);
// The types a transport may prune to a stub; board ops are never pruned.
export const STUBBABLE_TYPES: ReadonlySet<string> = new Set([
  'mail',
  'state',
  'presence',
]);

export const MAX_OP_BYTES = 1_048_576;
export const MAX_SEALED_RECIPIENTS = 256;
export const MAX_STATE_ENTRIES = 500;

export const REPLICA_ID = /^[A-Za-z0-9._-]{1,32}-[0-9a-f]{8}$/;
// The `prev` of a replica's key op, the first op of its log.
export const ZERO_HASH = '0'.repeat(64);

// Every signature and seal carries its own tag, so none can be replayed as another.
export const TAG = {
  op: 'dispatch-op-v2',
  sealed: 'dispatch-sealed-v1',
  ack: 'dispatch-ack-v1',
  relay: 'dispatch-relay-v1',
  invite: 'dispatch-invite-v1',
  recovery: 'dispatch-recovery-v1',
  fingerprint: 'dispatch-fp-v1',
} as const;

export interface OpHeader {
  v: 2;
  replica: string; // the publisher
  seq: number; // strictly increasing along its chain; may skip values
  prev: string; // opHash of its previous op; ZERO_HASH on its key op
  hlc: string; // `<ms>.<counter>.<replica>`, strictly increasing along its chain
  type: string; // an OpType, or a newer build's type, which still verifies
  to?: string[]; // sealed types only: recipient replicas, sorted, 1-256
  bodyHash: string; // hex sha256 of JCS({ body?, sealed? })
}

export interface Sealed {
  nonce: string; // 12 random bytes
  ct: string; // AES-256-GCM(K, nonce, JCS(payload), aad), 16-byte tag appended
  keys: Record<string, { enc: string; ct: string }>; // per replica in `to`: K sealed to it
}

export interface FederatedOp extends OpHeader {
  body?: JsonValue; // plain types; the clear part of a forward
  sealed?: Sealed; // mail and state
  sig: string; // Ed25519 over TAG.op + "\n" + JCS(the header)
}

// What replaces a pruned op: the header and its signature, unchanged, so the
// stub verifies exactly as the op did.
export interface OpStub extends OpHeader {
  sig: string;
  pruned: true;
}

export type LogEntry = FederatedOp | OpStub;

export interface MailPayload {
  message: Message; // as stored at its origin, `hlc` included, `origin` left out
  targets: MailTarget[]; // the origin's resolution of `to`
}

export interface MailTarget {
  recipient: Address;
  via: DeliveryVia;
  homes: string[]; // replicas that deliver it, the origin included when it holds or delivers it
  wakeAt?: string; // task targets of a `wake: 'request'` message: the one replica that may wake it
}

// A forward is a mail op whose clear body is { forward: FederatedOp } and
// whose sealed payload, for the one replica in `to`, is this.
export interface ForwardPayload {
  target: Address; // one of the original's targets
  key: string; // the original op's content key K
}

export interface StatePayload {
  entries: (
    | {
        t: 'delivery';
        message: string;
        recipient: Address;
        state: 'held' | 'pushed' | 'notified' | 'read' | 'answered';
        at: string;
      }
    | {
        t: 'settle';
        question: string;
        answer: string; // the accepted answer's id, or the close's
        closed?: string; // set when the origin closed the question
        at: string;
      }
    | {
        t: 'refused'; // this home refused a remote message
        message: string;
        reason: string; // the MessagingError's code and message
        at: string;
      }
  )[]; // at most MAX_STATE_ENTRIES per op
}

export interface KeyBody {
  handle: string; // the handle it asks to be admitted as
  device: string; // the short hostname
  build: string; // the Dispatch version
  signPub: string; // raw 32 bytes, base64url; this op's sig verifies with it
  sealPub: string; // raw 32 bytes, base64url
  legacy: { throughSeq: number; digest: string } | null; // its unsigned v1 history
  invite?: { id: string; sig: string };
}

export type RosterBody = { rv: 1 } & (
  | {
      action: 'found';
      name: string;
      legacy: LegacyAttestation[];
      recoveryPub: string;
    }
  | {
      action: 'admit';
      replica: string;
      handle: string;
      role: 'member' | 'admin';
      fingerprint: string;
      hosts?: string[]; // handles a shared host serves
      observer?: true; // reads team mail that leaves its senders' machines; speaks for nobody
    }
  | {
      action: 'revoke';
      replica: string;
      afterSeq: number; // its last op that stays valid
      afterHash: string; // opHash of that op, so the cut names one history
      reason: string;
    }
  // A demotion or a removal of hosts carries afterSeq/afterHash too.
  | {
      action: 'role';
      replica: string;
      role: 'member' | 'admin';
      afterSeq?: number;
      afterHash?: string;
    }
  | {
      action: 'hosts';
      replica: string;
      hosts: string[];
      afterSeq?: number;
      afterHash?: string;
    }
  | { action: 'close-legacy'; entries: LegacyAttestation[] }
  | { action: 'license'; key: string } // the organization's signed dispatch1.… key
  | {
      action: 'invite';
      id: string;
      pub: string;
      handle: string;
      expires: string;
    }
  | { action: 'recover'; proof: string }
  | { action: 'recovery-key'; pub: string } // a new recovery code replaces the last
  | { action: 'transport'; kind: 'git' | 'relay'; url?: string }
  // Drops the named roster op from every build's fold, as if never published.
  | { action: 'dismiss'; replica: string; seq: number; hash: string }
);

export interface LegacyAttestation {
  replica: string;
  throughSeq: number;
  digest: string; // sha256 over JCS(op) + "\n" for each of its v1 ops with seq ≤ throughSeq, in seq order
}

export type PresenceBody =
  | { kind: 'replica'; build: string; device: string; wall: number } // wall = its raw clock, ms
  | {
      kind: 'run';
      run: string;
      task: string | null;
      runKind: string; // execute | review | verify | …
      live: boolean;
      waitingOn?: string; // the handle an open gate or blocking question on this run waits for
    };

export interface AgentBody {
  address: Address; // agent:<op>/<name>; never agent:*/overseer or agent:*/a2a.*
  displayName: string;
  client: string;
  status: 'pending' | 'approved' | 'revoked';
}

export interface ChannelBody {
  channel: string;
  member: Address; // a task or an actor; never a run, a2a:*, agent:*/overseer or agent:*/a2a.*
  joined: boolean; // last writer wins per (channel, member) on the hlc
}

export interface MemoryBody {
  memory: string; // mem-<ulid>
  kind: 'put' | 'remove';
  fields?: Record<string, unknown>;
  trust: 'human' | 'confirmed' | 'agent'; // the trust the publisher asserts; receivers recompute it
}

// A JSON object whose fields the docs design owns: doc id, put | remove, `by`,
// an optional revision and optional `meta` fields.
export type DocBody = { [key: string]: JsonValue };

export function isStub(e: LogEntry): e is OpStub {
  return 'pruned' in e && e.pruned === true;
}

export function headerOf(e: LogEntry): OpHeader {
  const h: OpHeader = {
    v: 2,
    replica: e.replica,
    seq: e.seq,
    prev: e.prev,
    hlc: e.hlc,
    type: e.type,
    bodyHash: e.bodyHash,
  };
  if (e.to !== undefined) h.to = e.to;
  return h;
}

export function contentHash(content: {
  body?: JsonValue;
  sealed?: Sealed;
}): string {
  return sha256Hex(canonicalize(content));
}

export function signingInput(h: OpHeader): string {
  return `${TAG.op}\n${canonicalize(h)}`;
}

// The same for an op and its stub, so pruning never breaks a chain.
export function opHash(e: LogEntry): string {
  return sha256Hex(canonicalize({ ...headerOf(e), sig: e.sig }));
}

export function stubOf(op: FederatedOp): OpStub {
  return { ...headerOf(op), sig: op.sig, pruned: true };
}
