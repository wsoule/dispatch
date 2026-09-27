import type { JsonValue } from '../envelope.js';
import { compareHlc, parseOpHlc } from './hlc.js';
import { signText, verifyText } from './keys.js';
import {
  contentHash,
  headerOf,
  isStub,
  MAX_OP_BYTES,
  MAX_SEALED_RECIPIENTS,
  opHash,
  REPLICA_ID,
  SEALED_TYPES,
  signingInput,
  STUBBABLE_TYPES,
  ZERO_HASH,
} from './ops.js';
import type { FederatedOp, LogEntry, OpHeader, Sealed } from './ops.js';

const TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ChainHead {
  seq: number;
  hash: string;
  hlc: string;
}

// Signs a new op: the signature covers the header, which commits to the
// content through `bodyHash`.
export function buildOp(
  fields: {
    replica: string;
    seq: number;
    prev: string;
    hlc: string;
    type: string;
    body?: JsonValue;
    to?: string[];
    sealed?: Sealed;
  },
  signPriv: string
): FederatedOp {
  const content: { body?: JsonValue; sealed?: Sealed } = {};
  if (fields.body !== undefined) content.body = fields.body;
  if (fields.sealed !== undefined) content.sealed = fields.sealed;
  const header: OpHeader = {
    v: 2,
    replica: fields.replica,
    seq: fields.seq,
    prev: fields.prev,
    hlc: fields.hlc,
    type: fields.type,
    bodyHash: contentHash(content),
  };
  if (fields.to !== undefined) header.to = fields.to;
  return {
    ...header,
    ...content,
    sig: signText(signPriv, signingInput(header)),
  };
}

const fail = (reason: string) => ({ ok: false as const, reason });

// 1 to `max` replica ids in strictly ascending order.
function sortedUnique(list: unknown, max: number): boolean {
  if (!Array.isArray(list) || list.length === 0 || list.length > max)
    return false;
  let last = '';
  for (const r of list as unknown[]) {
    if (typeof r !== 'string' || !REPLICA_ID.test(r) || r <= last) return false;
    last = r;
  }
  return true;
}

function sameKeys(sorted: readonly string[], keys: string[]): boolean {
  const other = [...keys].sort();
  return (
    sorted.length === other.length && sorted.every((r, i) => r === other[i])
  );
}

const isHex64 = (v: unknown) => typeof v === 'string' && HEX64.test(v);

// What JCS and the checks below need of an entry parsed off the branch: an
// object with a string `sig` and hex hashes.
function wellFormed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
  const { prev, bodyHash, sig } = e as Record<string, unknown>;
  return typeof sig === 'string' && isHex64(prev) && isHex64(bodyHash);
}

// Null when JCS refuses the content, as it does a non-finite number.
function contentHashOrNull(content: {
  body?: JsonValue;
  sealed?: Sealed;
}): string | null {
  try {
    return contentHash(content);
  } catch {
    return null;
  }
}

// Checks one entry against the chain so far: the grammar, the signature, the
// content hash, prev, seq and hlc rising, and the stub and sealing rules. An
// unknown type verifies; handling it is the caller's. Never throws, since
// entries come off a branch anyone can write.
export function verifyEntry(
  head: ChainHead | null,
  e: LogEntry,
  signPub: string
): { ok: true; head: ChainHead } | { ok: false; reason: string } {
  if (!wellFormed(e)) return fail('malformed op');
  if (typeof e.replica !== 'string' || !REPLICA_ID.test(e.replica))
    return fail('replica id outside the grammar');
  if (e.v !== 2 || typeof e.type !== 'string' || !TYPE.test(e.type))
    return fail('not a v2 op');
  if (!Number.isSafeInteger(e.seq) || e.seq < 1) return fail('seq must rise');
  if (Buffer.byteLength(JSON.stringify(e)) > MAX_OP_BYTES)
    return fail('over MAX_OP_BYTES');
  const clock = typeof e.hlc === 'string' ? parseOpHlc(e.hlc) : null;
  if (clock === null || clock.replica !== e.replica)
    return fail('hlc must name its own replica');
  if (head === null) {
    if (isStub(e) || e.type !== 'key' || e.prev !== ZERO_HASH)
      return fail('a log must start with its key op');
  } else {
    if (e.type === 'key') return fail('a second key op');
    if (e.prev !== head.hash) return fail('prev does not match');
    if (e.seq <= head.seq) return fail('seq must rise');
    const before = parseOpHlc(head.hlc);
    if (before !== null && compareHlc(clock, before) <= 0)
      return fail('hlc must rise');
  }
  if (e.to !== undefined && !sortedUnique(e.to, MAX_SEALED_RECIPIENTS))
    return fail('bad recipient list');
  if (!verifyText(signPub, signingInput(headerOf(e)), e.sig))
    return fail('bad signature');
  if (isStub(e)) {
    if (!STUBBABLE_TYPES.has(e.type))
      return fail(`a ${e.type} op cannot be a stub`);
  } else {
    const content: { body?: JsonValue; sealed?: Sealed } = {};
    if (e.body !== undefined) content.body = e.body;
    if (e.sealed !== undefined) content.sealed = e.sealed;
    const hash = contentHashOrNull(content);
    if (hash === null) return fail('malformed op');
    if (hash !== e.bodyHash) return fail('bodyHash mismatch');
    const sealedType = SEALED_TYPES.has(e.type);
    if (sealedType && e.sealed === undefined)
      return fail('sealed types carry sealed content');
    if (e.type === 'state' && e.body !== undefined)
      return fail('state ops carry only sealed content');
    if (!sealedType && (e.sealed !== undefined || e.to !== undefined))
      return fail('only mail and state are sealed');
    // A forward is a mail op with both a clear body and sealed content.
    if (
      sealedType &&
      (e.to === undefined || !sameKeys(e.to, Object.keys(e.sealed?.keys ?? {})))
    )
      return fail('keys must equal to');
  }
  return { ok: true, head: { seq: e.seq, hash: opHash(e), hlc: e.hlc } };
}
