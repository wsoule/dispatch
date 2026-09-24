import { parseAddress, SYSTEM_ADDRESS } from './address.js';
import type { Address } from './address.js';
import { MessagingError } from './errors.js';
import { LINE_BREAK } from './lines.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const BUILT_IN_KINDS = [
  'message',
  'question',
  'answer',
  'handoff',
  'notice',
] as const;
export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];
export type MessageKind = BuiltInKind | `x-${string}`;

export const REF_TYPES = ['task', 'run', 'file', 'commit', 'message'] as const;
export interface Ref {
  type: (typeof REF_TYPES)[number];
  id: string;
  /** Commit sha for `file` refs. */
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
}

export const GATE_TYPES = [
  'tool-approval',
  'scope',
  'wake',
  'agent-registration',
  'overseer-action',
] as const;
export type GateData =
  | {
      type: 'tool-approval';
      requestId: string;
      runId?: string;
      conversation?: string;
      tool: string;
      input: JsonValue;
    }
  | { type: 'scope'; paths: string[]; reason: string }
  | { type: 'wake'; target: Address; message: string }
  | { type: 'agent-registration'; agent: Address; client: string }
  | {
      type: 'overseer-action';
      conversation: string;
      actionId: string;
      summary: string;
    };

const X_KIND = /^x-[a-z0-9][a-z0-9-]*$/;
const ASKING_KINDS: ReadonlySet<string> = new Set(['question', 'handoff']);

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

function invalid(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

// Rendered one-line fields must not break a line, or they could start a fake
// message header in the recipient's session.
function singleLine(value: string | undefined, field: string): void {
  if (typeof value === 'string' && LINE_BREAK.test(value))
    invalid(field, 'must not contain line breaks');
}

// Checks a gate payload's shape and who may send it: runs raise scope gates;
// every other gate is minted by the daemon (system) or a deciding human.
function validateGate(
  gate: GateData,
  input: SendInput,
  sender: Address,
  canDecide: boolean
): void {
  if (gate.type === 'scope') {
    if (!sender.startsWith('run:')) {
      throw new MessagingError(
        'forbidden',
        'only runs may request scope',
        'data'
      );
    }
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
    return;
  }
  if (sender !== SYSTEM_ADDRESS && !canDecide) {
    throw new MessagingError(
      'forbidden',
      `only Dispatch may raise ${gate.type} gates`,
      'data'
    );
  }
}

// Rejects any envelope the engine must not store. `replyTarget` is the message
// named by `replyTo` (null when absent or unknown); errors name the bad field.
export function validateSendInput(
  input: SendInput,
  sender: Address,
  canDecide: boolean,
  replyTarget: Message | null
): void {
  if (!Array.isArray(input.to) || input.to.length === 0)
    invalid('to', 'at least one recipient');
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
  singleLine(input.session, 'session');

  (input.refs ?? []).forEach((ref, i) => {
    if (!(REF_TYPES as readonly string[]).includes(ref.type))
      invalid(`refs[${i}].type`, 'unknown ref type');
    if (typeof ref.id !== 'string' || ref.id === '')
      invalid(`refs[${i}].id`, 'required');
    singleLine(ref.id, `refs[${i}].id`);
    singleLine(ref.at, `refs[${i}].at`);
  });

  const asking = ASKING_KINDS.has(kind);
  if (input.blocking === true && !asking)
    invalid('blocking', 'only questions and handoffs block');
  if (input.choices !== undefined) {
    if (!asking)
      invalid('choices', 'only questions and handoffs carry choices');
    const choices = input.choices;
    choices.forEach((c, i) => singleLine(c, `choices[${i}]`));
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
  singleLine(input.choice, 'choice');

  const replyTo = input.replyTo ?? null;
  if (kind === 'answer' && replyTo === null)
    invalid('replyTo', 'an answer needs the question id');
  if (replyTo !== null) {
    if (replyTarget === null)
      throw new MessagingError('not-found', `no message ${replyTo}`, 'replyTo');
    if (kind === 'answer') {
      if (!ASKING_KINDS.has(replyTarget.kind))
        invalid('replyTo', 'only questions and handoffs take answers');
      const targetGate = gateOf(replyTarget);
      if (targetGate !== null && !canDecide) {
        throw new MessagingError(
          'forbidden',
          'answering this gate needs the decide tier',
          'replyTo'
        );
      }
      const mustChoose = targetGate !== null || replyTarget.kind === 'handoff';
      if (mustChoose && !hasChoice)
        invalid(
          'choice',
          `choose one of ${(replyTarget.choices ?? []).join(', ')}`
        );
      if (hasChoice && !(replyTarget.choices ?? []).includes(input.choice!)) {
        invalid(
          'choice',
          `choose one of ${(replyTarget.choices ?? []).join(', ')}`
        );
      }
    }
  }

  const gate = gateOf(input);
  if (gate !== null) validateGate(gate, input, sender, canDecide);
}
