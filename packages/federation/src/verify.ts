import {
  fingerprint,
  fromB64u,
  isStub,
  opHash,
  verifyEntry,
} from '@dispatch-foo/protocol/federation';
import type {
  ChainHead,
  FederatedOp,
  LogEntry,
} from '@dispatch-foo/protocol/federation';

/** A replica's keys as its key op carried them; pinned once, never replaced. */
export interface PinnedKey {
  replica: string;
  handle: string;
  device: string;
  build: string;
  signPub: string;
  sealPub: string;
  fingerprint: string;
  /** The seq of the key op that pinned it. */
  keySeq: number;
  legacy: { throughSeq: number; digest: string } | null;
  invite?: { id: string; sig: string };
}

/** How far one replica's log has been read, and why it stopped if it did. */
export interface LogCursor {
  head: ChainHead | null;
  halted: string | null;
}

export interface LogResult {
  /** Newly verified entries in chain order, each with its op hash. */
  accepted: { entry: LogEntry; hash: string }[];
  cursor: LogCursor;
  /** The key this call pinned, or null when it pinned none. */
  pinned: PinnedKey | null;
  problem: string | null;
}

const RAW_KEY_BYTES = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Verifies one replica's log in seq order from its cursor. A failure halts the
// log at that op, since skipping it would break every later link.
export function verifyLog(
  replica: string,
  entries: readonly LogEntry[],
  cursor: LogCursor,
  pinned: PinnedKey | null
): LogResult {
  const out: LogResult = { accepted: [], cursor, pinned: null, problem: null };
  if (cursor.halted !== null) return out;
  const { ordered, forkAt } = inSeqOrder(replica, entries);
  let head = cursor.head;
  let pin = pinned;
  for (const e of ordered) {
    if (forkAt !== null && e.seq >= forkAt)
      return halt(out, replica, head, forkAt, 'two ops share this seq');
    if (head !== null && e.seq < head.seq) continue;
    if (head !== null && e.seq === head.seq) {
      if (hashOf(e) === head.hash) continue;
      return halt(out, replica, head, e.seq, 'two ops share this seq');
    }
    // A log's first op is its key op, verified with the key it carries.
    const offered = head === null ? keyOpSignPub(e) : null;
    const key = offered ?? pin?.signPub ?? null;
    if (key === null) {
      // A publisher with no key op yet waits, its cursor unmoved; one whose
      // key op is here but not first, or not usable, halts.
      if (head !== null || !ordered.some((x) => x.type === 'key')) break;
      const reason =
        e.type === 'key'
          ? 'malformed key op'
          : 'a log must start with its key op';
      return halt(out, replica, head, e.seq, reason);
    }
    const r = verifyEntry(head, e, key);
    if (!r.ok) return halt(out, replica, head, e.seq, r.reason);
    if (offered !== null) {
      const next = isStub(e) ? null : pinFromKeyOp(e);
      if (next === null)
        return halt(out, replica, head, e.seq, 'malformed key op');
      // Keys never rotate in place: a pinned replica's key op must match
      // its pin in every field, or the replica must join again.
      if (pin !== null && !samePin(pin, next)) {
        const problem = `${replica} shows a different key than the one pinned; it must join again as a new replica`;
        return { ...out, cursor: { head, halted: problem }, problem };
      }
      if (pin === null) out.pinned = next;
      pin = next;
    }
    head = r.head;
    out.accepted.push({ entry: e, hash: r.head.hash });
  }
  out.cursor = { head, halted: null };
  return out;
}

function halt(
  out: LogResult,
  replica: string,
  head: ChainHead | null,
  seq: number,
  reason: string
): LogResult {
  const problem = `${replica}'s log fails verification at seq ${seq}: ${reason}; revoke it, or have it push again`;
  return { ...out, cursor: { head, halted: problem }, problem };
}

// The replica's entries sorted by seq, one per seq, and the lowest seq where
// two different entries appeared. Entries with no integer seq cannot be placed.
function inSeqOrder(
  replica: string,
  entries: readonly LogEntry[]
): { ordered: LogEntry[]; forkAt: number | null } {
  const bySeq = new Map<number, LogEntry>();
  let forkAt: number | null = null;
  for (const e of entries) {
    if (!isPlaceable(e, replica)) continue;
    const seen = bySeq.get(e.seq);
    if (seen === undefined) {
      bySeq.set(e.seq, e);
      continue;
    }
    const hash = hashOf(e);
    if (hash === null || hash !== hashOf(seen))
      forkAt = forkAt === null ? e.seq : Math.min(forkAt, e.seq);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { ordered, forkAt };
}

function isPlaceable(e: unknown, replica: string): e is LogEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return o.replica === replica && Number.isSafeInteger(o.seq);
}

// Null in place of a throw: anyone can write the branch an entry came off.
function hashOf(e: LogEntry): string | null {
  try {
    return opHash(e);
  } catch {
    return null;
  }
}

function bodyOf(e: FederatedOp): Record<string, unknown> | null {
  const body = e.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return null;
  return body;
}

function keyOpSignPub(e: LogEntry): string | null {
  if (e.type !== 'key' || isStub(e)) return null;
  const signPub = bodyOf(e)?.signPub;
  return typeof signPub === 'string' ? signPub : null;
}

function isRawKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return fromB64u(v).length === RAW_KEY_BYTES;
  } catch {
    return false;
  }
}

function isLegacy(v: unknown): v is PinnedKey['legacy'] {
  if (v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const { throughSeq, digest } = v as Record<string, unknown>;
  return (
    Number.isSafeInteger(throughSeq) &&
    (throughSeq as number) >= 0 &&
    typeof digest === 'string' &&
    SHA256_HEX.test(digest)
  );
}

function isInvite(v: unknown): v is { id: string; sig: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const { id, sig } = v as Record<string, unknown>;
  return typeof id === 'string' && typeof sig === 'string';
}

// Whether two pins came from the same key op: every field it carries.
function samePin(a: PinnedKey, b: PinnedKey): boolean {
  return (
    a.replica === b.replica &&
    a.handle === b.handle &&
    a.device === b.device &&
    a.build === b.build &&
    a.signPub === b.signPub &&
    a.sealPub === b.sealPub &&
    a.keySeq === b.keySeq &&
    a.legacy?.throughSeq === b.legacy?.throughSeq &&
    a.legacy?.digest === b.legacy?.digest &&
    a.invite?.id === b.invite?.id &&
    a.invite?.sig === b.invite?.sig
  );
}

/** A handle every Dispatch accepts, at most 64 characters. */
export const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_LABEL_CHARS = 128;
// C0 and C1 controls, which a terminal or a log line would act on.
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++)
    if (isControl(value.charCodeAt(i))) return true;
  return false;
}

/** Why a key op's handle, device or build is not printable as is (M1), or
 *  null: the handle follows HANDLE, the others are 1-128 characters with no
 *  control characters. */
export function keyFieldsProblem(
  handle: string,
  device: string,
  build: string
): string | null {
  if (!HANDLE.test(handle))
    return `handle ${JSON.stringify(handle.slice(0, 80))} is not a handle`;
  for (const [name, value] of [
    ['device', device],
    ['build', build],
  ] as const)
    if (
      value.length === 0 ||
      value.length > MAX_LABEL_CHARS ||
      hasControl(value)
    )
      return `${name} is empty, too long or holds control characters`;
  return null;
}

/** A label from elsewhere made safe to print: controls out, capped. */
export function printable(value: string, max = MAX_LABEL_CHARS): string {
  let clean = '';
  for (let i = 0; i < value.length; i++)
    if (!isControl(value.charCodeAt(i))) clean += value.charAt(i);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// The pin a verified key op makes, or null when its body is not a KeyBody.
function pinFromKeyOp(e: FederatedOp): PinnedKey | null {
  const b = bodyOf(e);
  if (b === null) return null;
  const { handle, device, build, signPub, sealPub, legacy, invite } = b;
  if (
    typeof handle !== 'string' ||
    typeof device !== 'string' ||
    typeof build !== 'string' ||
    keyFieldsProblem(handle, device, build) !== null ||
    !isRawKey(signPub) ||
    !isRawKey(sealPub) ||
    !isLegacy(legacy)
  )
    return null;
  const pin: PinnedKey = {
    replica: e.replica,
    handle,
    device,
    build,
    signPub,
    sealPub,
    fingerprint: fingerprint(signPub, sealPub),
    keySeq: e.seq,
    legacy:
      legacy === null
        ? null
        : { throughSeq: legacy.throughSeq, digest: legacy.digest },
  };
  if (invite === undefined) return pin;
  if (!isInvite(invite)) return null;
  pin.invite = { id: invite.id, sig: invite.sig };
  return pin;
}
