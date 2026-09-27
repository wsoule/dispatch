import type { JsonValue } from '../envelope.js';
import { compareHlc, parseOpHlc } from './hlc.js';
import { canonicalize } from './jcs.js';
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
// content through `bodyHash`. Throws CanonicalizeError for content JCS
// refuses, and a RangeError for a header every peer would refuse.
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
  const problem = headerProblem(fields);
  if (problem !== null) throw new RangeError(`cannot sign: ${problem}`);
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

// The header rules that need no chain: what buildOp checks before signing and
// verifyEntry after. Null when the fields pass.
function headerProblem(h: {
  replica: unknown;
  seq: unknown;
  prev: unknown;
  hlc: unknown;
  type: unknown;
  to?: unknown;
}): string | null {
  if (typeof h.replica !== 'string' || !REPLICA_ID.test(h.replica))
    return 'replica id outside the grammar';
  if (typeof h.type !== 'string' || !TYPE.test(h.type)) return 'not a v2 op';
  if (!Number.isSafeInteger(h.seq) || (h.seq as number) < 1)
    return 'seq must rise';
  if (!isHex64(h.prev)) return 'malformed op';
  const clock = typeof h.hlc === 'string' ? parseOpHlc(h.hlc) : null;
  if (clock === null) return 'hlc outside the grammar';
  if (clock.replica !== h.replica) return 'hlc must name its own replica';
  if (h.to !== undefined && !sortedUnique(h.to, MAX_SEALED_RECIPIENTS))
    return 'bad recipient list';
  return null;
}

// What JCS and the checks below need of an entry parsed off the branch: an
// object with a string `sig` and hex hashes.
function wellFormed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
  const { prev, bodyHash, sig } = e as Record<string, unknown>;
  return typeof sig === 'string' && isHex64(prev) && isHex64(bodyHash);
}

// Null in place of a throw: JCS refuses a non-finite number, a lone surrogate
// and nesting past MAX_JSON_DEPTH.
function orNull<T>(step: () => T): T | null {
  try {
    return step();
  } catch {
    return null;
  }
}

// Checks an entry's grammar, signature, content hash and chain links, but not
// what its type means. Never throws: anyone can write the branch it came off.
export function verifyEntry(
  head: ChainHead | null,
  e: LogEntry,
  signPub: string
): { ok: true; head: ChainHead } | { ok: false; reason: string } {
  if (!wellFormed(e)) return fail('malformed op');
  if (e.v !== 2) return fail('not a v2 op');
  const problem = headerProblem(e);
  if (problem !== null) return fail(problem);
  // JCS writes JSON.stringify's bytes in another key order, and fails fast on
  // deep nesting where the native stringify spends seconds.
  const bytes = orNull(() => Buffer.byteLength(canonicalize(e)));
  if (bytes === null) return fail('malformed op');
  if (bytes > MAX_OP_BYTES) return fail('over MAX_OP_BYTES');
  if (head === null) {
    if (isStub(e) || e.type !== 'key' || e.prev !== ZERO_HASH)
      return fail('a log must start with its key op');
  } else {
    if (e.type === 'key') return fail('a second key op');
    if (e.prev !== head.hash) return fail('prev does not match');
    if (e.seq <= head.seq) return fail('seq must rise');
    const clock = parseOpHlc(e.hlc);
    const before = parseOpHlc(head.hlc);
    if (clock !== null && before !== null && compareHlc(clock, before) <= 0)
      return fail('hlc must rise');
  }
  if (!verifyText(signPub, signingInput(headerOf(e)), e.sig))
    return fail('bad signature');
  if (isStub(e)) {
    if (!STUBBABLE_TYPES.has(e.type))
      return fail(`a ${e.type} op cannot be a stub`);
    // Stub content is never hashed, so it could claim anything.
    if ('body' in e || 'sealed' in e) return fail('a stub carries no content');
  } else {
    const content: { body?: JsonValue; sealed?: Sealed } = {};
    if (e.body !== undefined) content.body = e.body;
    if (e.sealed !== undefined) content.sealed = e.sealed;
    const hash = orNull(() => contentHash(content));
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
