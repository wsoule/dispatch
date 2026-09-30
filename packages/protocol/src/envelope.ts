import { parseAddress, SYSTEM_ADDRESS } from './address.js';
import type { Address } from './address.js';
import {
  BUILT_IN_KINDS,
  GATE_TYPES,
  gateTypeOf,
  hasGateData,
  MAX_SEGMENT_BYTES,
  raiserOf,
  REF_TYPES,
} from './constants.js';
import { MessagingError } from './errors.js';
import { LINE_BREAK } from './lines.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export { GATE_TYPES };

export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];
export type MessageKind = BuiltInKind | `x-${string}`;

/** A ref type the registry lists; a received ref may carry any other identifier. */
export type RefType = (typeof REF_TYPES)[number];

export interface Ref {
  /** A registered ref type, or any identifier on a ref received from a peer (§4.4). */
  type: RefType | (string & {});
  id: string;
  /** A commit sha for `file` refs; a section anchor for `doc` refs. */
  at?: string;
}

export interface Message {
  id: string;
  thread: string;
  replyTo: string | null;
  from: Address;
  session?: string;
  to: Address[];
  kind: MessageKind;
  body: string;
  refs: Ref[];
  data?: JsonValue;
  urgent: boolean;
  blocking: boolean;
  choices?: string[];
  choice?: string;
  wake: 'none' | 'request';
  createdAt: string;
  /** The replica that created a remote message; absent when created here. */
  origin?: string;
  /** The origin's hybrid clock at send; threads order by it. */
  hlc?: string;
}

export interface SendInput {
  to: Address[];
  kind: MessageKind;
  body: string;
  refs?: Ref[];
  data?: JsonValue;
  urgent?: boolean;
  blocking?: boolean;
  choices?: string[];
  choice?: string;
  replyTo?: string | null;
  wake?: 'none' | 'request';
  session?: string;
  /** The sender's own dedupe key; a repeat returns the first message (A2A §3.3.1). */
  idempotencyKey?: string;
}

// The kinds a memory gate may name; @dispatch/memory pins its MEMORY_KINDS to
// this list.
export const MEMORY_GATE_KINDS = [
  'preference',
  'convention',
  'constraint',
  'hazard',
  'decision',
  'fact',
  'reference',
] as const;
const MEMORY_GATE_ACTIONS: readonly string[] = ['add', 'supersede', 'retire'];
const PROPOSAL_ID = /^mp-[0-9A-HJKMNP-TV-Z]{26}$/;

export type GateData =
  | {
      type: 'tool-approval';
      requestId: string;
      runId?: string;
      conversation?: string;
      tool: string;
      input: JsonValue; // at most an 8 KiB preview; the executor holds the real input
      truncated?: true; // set when `input` was cut to fit
      floor: boolean; // the irreversibility floor holds the call, judged on its full input
    }
  | { type: 'scope'; paths: string[]; reason: string }
  | { type: 'wake'; target: Address; message: string }
  | {
      type: 'agent-registration';
      agent: Address;
      client: string;
      // The human who asked; the agent registers under their handle.
      requestedBy?: Address;
    }
  | {
      type: 'overseer-action';
      conversation: string;
      actionId: string;
      summary: string;
    }
  | {
      type: 'memory';
      proposalId: string; // mp-<ulid>; the content stays in memory.db
      action: 'add' | 'supersede' | 'retire';
      scope: 'project' | 'team';
      kind: (typeof MEMORY_GATE_KINDS)[number];
    }
  | {
      type: 'task-proposal';
      // The draft an A2A client handed off, and who proposed it (system-only gate).
      task: string;
      proposedBy: Address;
      message: string;
    }
  | {
      type: 'doc';
      // A proposed edit to an accepted doc; the text stays in docs.db (system-only gate).
      doc: string; // doc-<ulid>
      proposal: string; // rev-<ulid>
      taskId?: string;
      runId?: string;
    };

/** How validateSendInput judges gates, refs and a missing reply target. */
export interface ValidateOptions {
  /** The gate types the host implements; default every GATE_TYPES entry. */
  gateTypes?: ReadonlySet<string>;
  /** `received` for a message that arrived through a binding: it keeps unknown ref types. */
  origin?: 'local' | 'received';
  /** A federated receive: a reply whose target is not stored skips the checks that need it. */
  parentOptional?: boolean;
}

const PACKAGE_GATE_TYPES: ReadonlySet<string> = new Set(GATE_TYPES);

const X_KIND = /^x-[a-z0-9][a-z0-9-]*$/;
// §1.4's identifier grammar; an identifier's cap is the segment cap.
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const ASKING_KINDS: ReadonlySet<string> = new Set(['question', 'handoff']);

// Caps on one send, so no message can flood a recipient's session or the store.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_REFS = 50;
const MAX_CHOICES = 20;
// Caps on one-line fields, in UTF-8 bytes.
const MAX_REF_BYTES = 512;
const MAX_LABEL_BYTES = 200;

/** The gate payload a message carries, or null when `data` is not a gate. */
export function gateOf(message: { data?: JsonValue }): GateData | null {
  const data = message.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return null;
  const type = (data as { [key: string]: JsonValue })['type'];
  return typeof type === 'string' &&
    (GATE_TYPES as readonly string[]).includes(type)
    ? (data as unknown as GateData)
    : null;
}

// True only for this daemon's own marker: a client, peer, human or another
// replica's system cannot forge one.
export function isSystemMarker(
  message: Pick<Message, 'from' | 'data' | 'origin'>,
  type: 'x-closed' | 'x-breaker'
): boolean {
  const data = message.data;
  return (
    message.from === SYSTEM_ADDRESS &&
    message.origin === undefined &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { [key: string]: JsonValue })['type'] === type
  );
}

function invalid(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

/** §1.4's identifier: lowercase, no line breaks, at most one segment's bytes. */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    IDENTIFIER.test(value) &&
    value.length <= MAX_SEGMENT_BYTES
  );
}

// True when `text` is over `max` UTF-8 bytes. A UTF-16 code unit encodes to
// 1–3 bytes, so only lengths between max/3 and max need the encoder.
function overBytes(text: string, max: number): boolean {
  if (text.length > max) return true;
  if (text.length * 3 <= max) return false;
  return new TextEncoder().encode(text).byteLength > max;
}

// Rendered one-line fields must stay short and unbroken, or they could flood
// or start a fake message header in the recipient's session.
function singleLine(
  value: string | undefined,
  field: string,
  maxBytes: number
): void {
  if (typeof value !== 'string') return;
  if (LINE_BREAK.test(value)) invalid(field, 'must not contain line breaks');
  if (overBytes(value, maxBytes))
    invalid(field, `at most ${maxBytes} bytes (UTF-8)`);
}

// A sender-chosen dedupe key: one line, 1..200 UTF-8 bytes, like `session`.
export function checkIdempotencyKey(key: string): void {
  if (key === '') invalid('idempotencyKey', 'must not be empty');
  singleLine(key, 'idempotencyKey', MAX_LABEL_BYTES);
}

// Gate data travels only on questions and handoffs, only for a type this host
// implements, and only from the raiser the type allows.
function validateGate(
  input: SendInput,
  sender: Address,
  canDecide: boolean,
  known: ReadonlySet<string>
): void {
  const type = (input.data as { type: string }).type;
  if (!ASKING_KINDS.has(input.kind))
    invalid(
      'data.type',
      'gate data travels only on questions and handoffs; private payloads use an x- type'
    );
  if (!known.has(type))
    invalid(
      'data.type',
      `unregistered or unimplemented gate type ${type}; private payloads use an x- type`
    );
  if (type === 'memory') validateMemoryShape(input);
  if (type === 'doc') validateDocShape(input);
  const raiser = raiserOf(type);
  if (raiser === 'session' && !sender.startsWith('run:')) {
    throw new MessagingError(
      'forbidden',
      `only runs may request ${type}`,
      'data'
    );
  }
  if (raiser === 'system' && sender !== SYSTEM_ADDRESS) {
    throw new MessagingError(
      'forbidden',
      `only Dispatch may raise ${type} gates`,
      'data'
    );
  }
  if (
    raiser === 'system-or-decider' &&
    sender !== SYSTEM_ADDRESS &&
    !(canDecide && sender.startsWith('human:'))
  ) {
    throw new MessagingError(
      'forbidden',
      `only Dispatch may raise ${type} gates, or a deciding human`,
      'data'
    );
  }
  if (type === 'scope') validateScopeShape(input);
}

// A scope request names its paths and reason and has one fixed question shape.
function validateScopeShape(input: SendInput): void {
  const gate = input.data as unknown as Extract<GateData, { type: 'scope' }>;
  if (
    !Array.isArray(gate.paths) ||
    gate.paths.length === 0 ||
    !gate.paths.every((p) => typeof p === 'string' && p !== '')
  ) {
    invalid('data.paths', 'expected a non-empty list of paths');
  }
  if (typeof gate.reason !== 'string' || gate.reason.trim() === '')
    invalid('data.reason', 'required');
  if (
    input.kind !== 'question' ||
    input.blocking !== true ||
    JSON.stringify(input.choices) !== '["grant","deny"]'
  ) {
    invalid(
      'data',
      'a scope request is { kind: "question", blocking: true, choices: ["grant", "deny"], data: { type: "scope", paths, reason } }'
    );
  }
}

// A memory gate names its proposal, never its content, and has one fixed
// question shape.
function validateMemoryShape(input: SendInput): void {
  const gate = input.data as unknown as Extract<GateData, { type: 'memory' }>;
  if (typeof gate.proposalId !== 'string' || !PROPOSAL_ID.test(gate.proposalId))
    invalid('data.proposalId', 'expected a proposal id like mp-01K…');
  if (!MEMORY_GATE_ACTIONS.includes(gate.action))
    invalid('data.action', `expected ${MEMORY_GATE_ACTIONS.join('|')}`);
  if (gate.scope !== 'project' && gate.scope !== 'team')
    invalid('data.scope', 'expected project|team');
  if (!(MEMORY_GATE_KINDS as readonly string[]).includes(gate.kind))
    invalid('data.kind', `expected ${MEMORY_GATE_KINDS.join('|')}`);
  if (
    input.kind !== 'question' ||
    input.blocking !== true ||
    JSON.stringify(input.choices) !== '["approve","reject"]'
  ) {
    invalid(
      'data',
      'a memory gate is { kind: "question", blocking: true, choices: ["approve", "reject"], data: { type: "memory", proposalId, action, scope, kind } }'
    );
  }
}

// A doc gate names the doc and its proposed revision, never the text, and has
// one fixed question shape.
function validateDocShape(input: SendInput): void {
  const gate = input.data as unknown as Extract<GateData, { type: 'doc' }>;
  if (typeof gate.doc !== 'string' || !gate.doc.startsWith('doc-'))
    invalid('data.doc', 'expected a doc- id');
  if (typeof gate.proposal !== 'string' || !gate.proposal.startsWith('rev-'))
    invalid('data.proposal', 'expected a rev- id');
  if (
    input.kind !== 'question' ||
    input.blocking !== true ||
    JSON.stringify(input.choices) !== '["approve","reject"]'
  ) {
    invalid(
      'data',
      'a doc gate is { kind: "question", blocking: true, choices: ["approve", "reject"], data: { type: "doc", doc, proposal } }'
    );
  }
}

// Rejects any envelope the engine must not store. `replyTarget` is the message
// named by `replyTo` (null when absent or unknown); errors name the bad field.
export function validateSendInput(
  input: SendInput,
  sender: Address,
  canDecide: boolean,
  replyTarget: Message | null,
  options: ValidateOptions = {}
): void {
  const known = options.gateTypes ?? PACKAGE_GATE_TYPES;
  if (!Array.isArray(input.to) || input.to.length === 0)
    invalid('to', 'at least one recipient');
  if (input.to.length > MAX_RECIPIENTS)
    invalid('to', `at most ${MAX_RECIPIENTS} recipients`);
  input.to.forEach((addr, i) => parseAddress(addr, `to[${i}]`));

  const kind = input.kind;
  if (
    !(BUILT_IN_KINDS as readonly string[]).includes(kind) &&
    !X_KIND.test(kind)
  ) {
    invalid('kind', `unknown kind ${JSON.stringify(kind)}`);
  }
  const hasChoice = typeof input.choice === 'string';
  if (
    typeof input.body !== 'string' ||
    (input.body.trim() === '' && !(kind === 'answer' && hasChoice))
  ) {
    invalid('body', 'required');
  }
  if (overBytes(input.body, MAX_BODY_BYTES))
    invalid('body', `at most ${MAX_BODY_BYTES} bytes (UTF-8)`);
  if (
    input.data !== undefined &&
    overBytes(JSON.stringify(input.data), MAX_DATA_BYTES)
  )
    invalid('data', `at most ${MAX_DATA_BYTES} bytes as JSON`);
  singleLine(input.session, 'session', MAX_LABEL_BYTES);
  if (input.idempotencyKey !== undefined)
    checkIdempotencyKey(input.idempotencyKey);

  const refs = input.refs ?? [];
  if (refs.length > MAX_REFS) invalid('refs', `at most ${MAX_REFS} refs`);
  refs.forEach((ref, i) => {
    const registered = (REF_TYPES as readonly string[]).includes(ref.type);
    // A peer's newer ref type is kept, not refused, so a minor version can add one.
    const receivedOk = options.origin === 'received' && isIdentifier(ref.type);
    if (!registered && !receivedOk)
      invalid(`refs[${i}].type`, 'unknown ref type');
    if (typeof ref.id !== 'string' || ref.id === '')
      invalid(`refs[${i}].id`, 'required');
    singleLine(ref.id, `refs[${i}].id`, MAX_REF_BYTES);
    singleLine(ref.at, `refs[${i}].at`, MAX_REF_BYTES);
  });

  const asking = ASKING_KINDS.has(kind);
  if (input.blocking === true && !asking)
    invalid('blocking', 'only questions and handoffs block');
  if (input.choices !== undefined) {
    if (!asking)
      invalid('choices', 'only questions and handoffs carry choices');
    const choices = input.choices;
    if (choices.length > MAX_CHOICES)
      invalid('choices', `at most ${MAX_CHOICES} choices`);
    choices.forEach((c, i) => singleLine(c, `choices[${i}]`, MAX_LABEL_BYTES));
    if (
      choices.length === 0 ||
      new Set(choices).size !== choices.length ||
      choices.some((c) => c.trim() === '')
    ) {
      invalid('choices', 'expected distinct, non-empty choices');
    }
  }
  if (hasChoice && kind !== 'answer')
    invalid('choice', 'only answers carry a choice');
  singleLine(input.choice, 'choice', MAX_LABEL_BYTES);

  const replyTo = input.replyTo ?? null;
  if (kind === 'answer' && replyTo === null)
    invalid('replyTo', 'an answer needs the question id');
  if (replyTo !== null) {
    // A received reply may name a parent that never reached this replica.
    if (replyTarget === null) {
      if (options.parentOptional !== true)
        throw new MessagingError(
          'not-found',
          `no message ${replyTo}`,
          'replyTo'
        );
    } else if (kind === 'answer') {
      if (!ASKING_KINDS.has(replyTarget.kind))
        invalid('replyTo', 'only questions and handoffs take answers');
      const isGate = gateTypeOf(replyTarget, known) !== null;
      if (isGate && !canDecide) {
        throw new MessagingError(
          'forbidden',
          'answering this gate needs the decide tier',
          'replyTo'
        );
      }
      // A gate or handoff answer carries one of its choices when it has any,
      // and none when it has none (a choiceless answer needs a body, above).
      const choices = replyTarget.choices ?? [];
      if (
        (isGate || replyTarget.kind === 'handoff') &&
        choices.length > 0 &&
        !hasChoice
      )
        invalid('choice', `choose one of ${choices.join(', ')}`);
      if (hasChoice && !choices.includes(input.choice!))
        invalid('choice', `choose one of ${choices.join(', ')}`);
    }
  }

  if (hasGateData(input)) validateGate(input, sender, canDecide, known);
}
