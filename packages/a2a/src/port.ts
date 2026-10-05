import type { A2AConfig, A2ASkill } from '@dispatch/core';
import type {
  Address,
  DeliveryState,
  JsonValue,
  Message,
  Ref,
} from '@dispatch/protocol';

import type { GateTypeName, WorkArtifactV1, WorkRequestV1 } from './ext.js';
import type { PushConfigInput, PushConfigJson } from './push.js';
import type { ReceivedRequest } from './sig/verify.js';
import type { TaskStateName } from './states.js';
import type { HandoffPhase } from './statuses.js';
import type { ArtifactJson } from './wire.js';

// The one seam between the A2A handler and a host: the host gathers facts and
// applies effects, the handler decides.

export interface Caller {
  address: Address;
  name: string;
  // The card-key thumbprint a signed caller proved; every re-check requires
  // the client row to pin it still.
  keyid?: string;
  // The client's own bearer, which a standalone host forwards to the daemon;
  // opaque to handleA2A.
  credential?: string;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | {
      ok: false;
      // 429 only for a signed caller at its nonce cap.
      status: 401 | 403 | 429;
      reason: string;
      message: string;
      retryAfterSec?: number;
      // Set when the signature verified but the caller may not call: its
      // refusal is signed, so the peer can trust it.
      verified?: Caller;
    };

export type OpenKind = 'ask' | 'message' | 'notice' | 'handoff' | 'status';

export interface OpenInput {
  clientMessageId: string;
  contextId: string | null;
  kind: OpenKind;
  to: Address[] | null;
  replyTo: string | null;
  body: string;
  data?: JsonValue;
  refs: Ref[];
  choices?: string[];
  work?: WorkRequestV1;
}

// A send that opens no task (plain message, notice, status) gets a direct reply.
export type OpenResult =
  | { kind: 'task'; taskId: string }
  | {
      kind: 'reply';
      text: string;
      data?: JsonValue;
      about?: { id: string; thread: string };
    };

export interface ContinueInput {
  clientMessageId: string;
  taskId: string;
  contextId: string | null;
  body: string;
  data?: JsonValue;
  refs: Ref[];
  choice?: string;
}

export interface ContinueResult {
  reask: string | null;
}

export interface OpenGateFact {
  id: string;
  type: GateTypeName;
  openedAt: string;
}

// Everything the projection needs to decide one task's A2A state.
export interface TaskFacts {
  id: string;
  contextId: string;
  skill: 'ask' | 'handoff';
  client: Address;
  createdAt: string;
  canceledAt: string | null;
  declinedAt: string | null;
  root: Message;
  scope: Message[];
  rootDeliveries: DeliveryState[];
  answer: Message | null;
  openQuestions: Message[];
  openGates: OpenGateFact[];
  // `status` is the project's name for it; `phase` is what the host's status
  // model says it means, which is all the projection reads.
  task:
    | {
        id: string;
        title: string;
        status: string;
        phase: HandoffPhase;
        approved: boolean;
      }
    | 'deleted'
    | null;
  dropped: 'client' | 'other' | null;
  recipientTaskDropped: boolean;
  work: {
    pr?: WorkArtifactV1;
    diffstat?: WorkArtifactV1;
    evidence?: WorkArtifactV1;
  };
  clientIds: Record<string, string>;
  // Artifacts a host publishes as they are, ahead of Dispatch's own;
  // dispatchd sets none.
  hostArtifacts?: ArtifactJson[];
}

export interface ListQuery {
  contextId?: string;
  state?: TaskStateName;
  after?: string;
  pageSize: number;
  pageToken?: string;
}

export interface ListPage {
  ids: string[];
  nextPageToken: string;
  totalSize: number;
}

export type Admission =
  | { ok: true; release?: () => void }
  | { ok: false; retryAfterSec: number };

/** A JWS over the card (a2a.proto v1.0.1 AgentCardSignature). */
export interface CardSignatureJson {
  protected: string;
  signature: string;
  header?: Record<string, JsonValue>;
}

/** Public keys only, served at JWKS_PATH; never part of the card. */
export interface Jwks {
  keys: Record<string, JsonValue>[];
}

/** Who a card is built for. Only a trusted host (T36) sets these, never a
 *  request's Host or X-Forwarded-* headers. */
export interface CardRequest {
  publicUrl?: string;
  // A standalone host: push delivery is the daemon's, so it is off there.
  standalone?: boolean;
}

export interface CardInputs {
  name: string;
  description: string | null;
  publicUrl: string;
  version: string;
  skills: A2ASkill[];
  blockingWaitSec: number;
  pushNotifications: boolean;
  // Signed by the card key: the card advertises the signature extension.
  signing?: boolean;
  signatures?: CardSignatureJson[];
  jwks?: Jwks;
}

export type A2APolicy = A2AConfig;

/** A host's push configs; every method answers only for the caller's own tasks. */
export interface PushConfigPort {
  // A config's URL and the caps, checked before a send carrying it inline
  // goes out, so a refused config sends nothing. `taskId` is null for a new task.
  check(
    caller: Caller,
    input: PushConfigInput,
    taskId: string | null
  ): Promise<void>;
  // A2AError TASK_NOT_FOUND; MessagingError limited, or invalid on 'url'.
  create(
    caller: Caller,
    taskId: string,
    input: PushConfigInput
  ): Promise<PushConfigJson>;
  get(
    caller: Caller,
    taskId: string,
    id: string
  ): Promise<PushConfigJson | null>;
  list(caller: Caller, taskId: string): Promise<PushConfigJson[]>;
  // Idempotent: deleting an unknown id succeeds.
  delete(caller: Caller, taskId: string, id: string): Promise<void>;
}

export type ExtensionRoute = 'pair' | 'unpair' | 'key-change' | 'upgrade';

export interface BridgePort {
  // `presented`: the extension URIs the request's A2A-Extensions header named.
  authenticate(bearer: string, presented?: string[]): Promise<AuthResult>;
  // A request a Dispatch peer signed (RFC 9421). null when it carries no
  // Dispatch signature, so the bearer path decides; absent, signatures are ignored.
  authenticateSigned?(req: ReceivedRequest): Promise<AuthResult | null>;
  // Whether a caller that signed in may still stream; bearer callers re-run authenticate.
  revalidate?(caller: Caller): Promise<boolean>;
  // Signs the response to a request that authenticated by signature, so the
  // peer can tell it came from this agent; required with authenticateSigned.
  signResponse?(res: Response, req: Request, caller: Caller): Promise<Response>;
  // POST <base>/dispatch/<route>: a pairing proof or a signed unpair notice
  // (P5); absent, 404.
  extension?(route: ExtensionRoute, req: Request): Promise<Response>;
  // The last key-change or revocation statement, served at
  // KEY_STATEMENT_PATH; null (404) when there is none.
  keyStatement?(): Promise<string | null>;
  admit(caller: Caller, what: 'request' | 'stream'): Promise<Admission>;
  card(req?: CardRequest): Promise<CardInputs>;
  open(caller: Caller, input: OpenInput): Promise<OpenResult>;
  continue(caller: Caller, input: ContinueInput): Promise<ContinueResult>;
  // null when the task is absent or not the caller's.
  facts(caller: Caller, taskId: string): Promise<TaskFacts | null>;
  list(caller: Caller, query: ListQuery): Promise<ListPage>;
  // Throws A2AError('TASK_NOT_CANCELABLE', …) when the task cannot be canceled.
  cancel(caller: Caller, taskId: string): Promise<void>;
  watch(caller: Caller, taskId: string, onChange: () => void): () => void;
  // Absent: push routes answer PUSH_NOTIFICATION_NOT_SUPPORTED.
  readonly pushConfigs?: PushConfigPort;
}
