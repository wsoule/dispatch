import { createHmac, randomBytes } from 'node:crypto';

import type { JsonValue } from '../envelope.js';
import { b64u, fromB64u } from './encoding.js';
import { aeadOpen, aeadSeal } from './hpke.js';
import { canonicalizeLenient } from './jcs.js';
import { TAG } from './ops.js';

// End-to-end encrypted team content: a content op's body becomes an envelope
// under the team content key (TCK) of a roster epoch, which relays never hold.

export const TEAM_CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 12;

// The op types whose body travels as an envelope once a team switched to e2e.
export const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'task',
  'presence',
  'agent',
  'channel',
  'memory',
  'doc',
]);

export type ContentEnvelope = {
  e2e: 1;
  epoch: string; // opHash of the roster op that opened the key's epoch
  nonce: string; // 12 random bytes
  ct: string; // AES-256-GCM(TCK, nonce, JCS(body), contentAad), 16-byte tag appended
  kind?: string; // presence: its kind, which the relay's retention reads
  run?: string; // presence: runTag of its run id, so retention still groups by run
  caps?: string[]; // replica presence: what its build speaks
  wants?: string[]; // replica presence: epochs whose key its machine lacks
};

// One epoch's key, as a sealed `state` op's grant payload carries it.
export interface ContentKeyGrant {
  epoch: string;
  key: string; // the epoch's TCK, base64url
}

export interface GrantPayload {
  grant: ContentKeyGrant[];
}

export function generateContentKey(): Buffer {
  return randomBytes(TEAM_CONTENT_KEY_BYTES);
}

// Binds a ciphertext to its op, so it cannot be moved into another one.
export function contentAad(replica: string, seq: number, type: string): string {
  return `${TAG.content}\n${replica}\n${seq}\n${type}`;
}

// Stands in for a run id in clear presence: equal ids give equal tags under one key.
export function runTag(key: Buffer, runId: string): string {
  return createHmac('sha256', key).update(runId).digest('hex');
}

export function isContentEnvelope(body: unknown): body is ContentEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return false;
  const b = body as Record<string, unknown>;
  return (
    b.e2e === 1 &&
    typeof b.epoch === 'string' &&
    typeof b.nonce === 'string' &&
    typeof b.ct === 'string'
  );
}

function checkKey(key: Buffer): void {
  if (key.length !== TEAM_CONTENT_KEY_BYTES)
    throw new RangeError(
      `a team content key is ${TEAM_CONTENT_KEY_BYTES} bytes`
    );
}

type Hints = Pick<ContentEnvelope, 'kind' | 'run' | 'caps' | 'wants'>;

// The clear fields presence keeps for the relay's retention: kind, a tagged
// run, and on replica presence its caps and the epochs it wants.
function hintsOf(
  type: string,
  body: JsonValue,
  key: Buffer,
  wants: readonly string[] | undefined
): Hints {
  if (type !== 'presence' || typeof body !== 'object' || body === null)
    return {};
  if (Array.isArray(body)) return {};
  const hints: Hints = {};
  if (typeof body.kind === 'string') hints.kind = body.kind;
  if (typeof body.run === 'string') hints.run = runTag(key, body.run);
  if (
    body.kind === 'replica' &&
    Array.isArray(body.caps) &&
    body.caps.every((c) => typeof c === 'string')
  )
    hints.caps = body.caps;
  if (body.kind === 'replica' && wants !== undefined && wants.length > 0)
    hints.wants = [...wants];
  return hints;
}

// Encrypts a content op's body once its stamp (seq) is known. Throws a
// RangeError for a type outside CONTENT_TYPES or a key of the wrong length.
export function encryptContent(input: {
  replica: string;
  seq: number;
  type: string;
  body: JsonValue;
  epoch: string;
  key: Buffer;
  /** Replica presence only: epochs this machine lacks, in the clear. */
  wants?: readonly string[];
}): ContentEnvelope {
  if (!CONTENT_TYPES.has(input.type))
    throw new RangeError(`a ${input.type} op is not team content`);
  checkKey(input.key);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = aeadSeal(
    input.key,
    nonce,
    Buffer.from(contentAad(input.replica, input.seq, input.type)),
    Buffer.from(canonicalizeLenient(input.body))
  );
  return {
    e2e: 1,
    epoch: input.epoch,
    nonce: b64u(nonce),
    ct: b64u(ct),
    ...hintsOf(input.type, input.body, input.key, input.wants),
  };
}

// A replica presence from a machine that holds no key for the current epoch:
// clear hints only, no ciphertext, so it can still ask for the keys it wants.
export function contentKeyRequest(input: {
  epoch: string;
  caps?: readonly string[];
  wants: readonly string[];
}): ContentEnvelope {
  return {
    e2e: 1,
    epoch: input.epoch,
    nonce: '',
    ct: '',
    kind: 'replica',
    ...(input.caps === undefined ? {} : { caps: [...input.caps] }),
    wants: [...input.wants],
  };
}

export function isContentKeyRequest(body: unknown): boolean {
  return isContentEnvelope(body) && body.ct === '' && body.kind === 'replica';
}

// The original body of a content op. Throws when its body is no envelope, or
// on a wrong key, a moved ciphertext or any tampering.
export function decryptContent(
  op: { replica: string; seq: number; type: string; body?: JsonValue },
  key: Buffer
): JsonValue {
  if (!isContentEnvelope(op.body))
    throw new TypeError('the op body is not a content envelope');
  checkKey(key);
  const pt = aeadOpen(
    key,
    fromB64u(op.body.nonce),
    Buffer.from(contentAad(op.replica, op.seq, op.type)),
    fromB64u(op.body.ct)
  );
  return JSON.parse(pt.toString('utf8')) as JsonValue;
}
