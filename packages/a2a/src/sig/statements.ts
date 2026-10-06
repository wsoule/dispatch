import type { JsonValue } from '@dispatch-foo/protocol';
import { canonicalize } from '@dispatch-foo/protocol/federation';
import { createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint, publicJwkOf } from './keys.js';

// Signed statements between paired agents. Each carries its own tag, so one
// kind can never pass as another.

const UNPAIR_TAG = 'dispatch-a2a-unpair-v1';

/** The body of POST <base>/dispatch/unpair; the request itself is RFC 9421-signed. */
export interface UnpairNotice {
  tag: typeof UNPAIR_TAG;
  id: string;
  at: string;
}

export function unpairNotice(id: string, at: Date): UnpairNotice {
  return { tag: UNPAIR_TAG, id, at: at.toISOString() };
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The notice's pairing id and time, or null for anything else. */
export function parseUnpairNotice(
  raw: unknown
): { id: string; at: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  if (r.tag !== UNPAIR_TAG || typeof r.id !== 'string' || !ID.test(r.id))
    return null;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  return { id: r.id, at: r.at };
}

const ROTATE_TAG = 'dispatch-a2a-rotate-v1';
const REVOKE_TAG = 'dispatch-a2a-revoke-v1';

/** A planned rotation, signed by the old key: peers move their pin to `new`. */
export interface KeyChangeStatement {
  v: 1;
  old: string;
  new: Record<string, string>;
  at: string;
  sig: string;
}

/** A compromised key, revoked by itself: peers drop the pairing. */
export interface RevocationStatement {
  v: 1;
  revoked: string;
  at: string;
  sig: string;
}

// The signed bytes: the tag, a newline, and the JCS of the statement minus sig.
function statementBytes(tag: string, body: Record<string, JsonValue>): Buffer {
  return Buffer.from(`${tag}\n${canonicalize(body)}`);
}

function signStatement(
  tag: string,
  body: Record<string, JsonValue>,
  key: KeyObject
): string {
  return sign('sha256', statementBytes(tag, body), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

// Verifies `sig` over the body under the pinned key; never throws.
function verifies(
  tag: string,
  body: Record<string, JsonValue>,
  sig: unknown,
  pinned: Record<string, string>
): boolean {
  if (typeof sig !== 'string') return false;
  try {
    return verify(
      'sha256',
      statementBytes(tag, body),
      {
        key: createPublicKey({ key: pinned, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(sig, 'base64url')
    );
  } catch {
    return false;
  }
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const validAt = (at: unknown): at is string =>
  typeof at === 'string' && !Number.isNaN(Date.parse(at));

export function makeKeyChange(i: {
  oldJwk: Record<string, string>;
  oldKey: KeyObject;
  newJwk: Record<string, string>;
  at: Date;
}): KeyChangeStatement {
  const body = {
    v: 1 as const,
    old: ecThumbprint(i.oldJwk) ?? '',
    new: publicJwkOf(i.newJwk),
    at: i.at.toISOString(),
  };
  return { ...body, sig: signStatement(ROTATE_TAG, body, i.oldKey) };
}

export type StatementCheck<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: string };

/** A key change verified under `pinned`, the key it says it replaces. */
export function checkKeyChange(
  raw: unknown,
  pinned: Record<string, string>
): StatementCheck<{
  newJwk: Record<string, string>;
  newThumbprint: string;
  at: string;
}> {
  if (!isRecord(raw) || raw.v !== 1 || !validAt(raw.at) || !isRecord(raw.new))
    return { ok: false, reason: 'not a key-change statement' };
  const old = ecThumbprint(pinned);
  if (old === null || raw.old !== old)
    return {
      ok: false,
      reason: 'it replaces a key that is not the pinned one',
    };
  let newJwk: Record<string, string>;
  try {
    newJwk = publicJwkOf(raw.new);
  } catch {
    return { ok: false, reason: 'its new key is not a P-256 public key' };
  }
  const newThumbprint = ecThumbprint(newJwk);
  if (newThumbprint === null)
    return { ok: false, reason: 'its new key is not a P-256 public key' };
  const body = { v: 1 as const, old, new: newJwk, at: raw.at };
  if (!verifies(ROTATE_TAG, body, raw.sig, pinned))
    return { ok: false, reason: 'it is not signed by the pinned key' };
  return { ok: true, newJwk, newThumbprint, at: raw.at };
}

export function makeRevocation(i: {
  oldJwk: Record<string, string>;
  oldKey: KeyObject;
  at: Date;
}): RevocationStatement {
  const body = {
    v: 1 as const,
    revoked: ecThumbprint(i.oldJwk) ?? '',
    at: i.at.toISOString(),
  };
  return { ...body, sig: signStatement(REVOKE_TAG, body, i.oldKey) };
}

/** A revocation of `pinned`, signed by it. */
export function checkRevocation(
  raw: unknown,
  pinned: Record<string, string>
): StatementCheck<{ at: string }> {
  if (
    !isRecord(raw) ||
    raw.v !== 1 ||
    !validAt(raw.at) ||
    typeof raw.revoked !== 'string'
  )
    return { ok: false, reason: 'not a revocation statement' };
  if (raw.revoked !== ecThumbprint(pinned))
    return { ok: false, reason: 'it revokes a key that is not the pinned one' };
  const body = { v: 1 as const, revoked: raw.revoked, at: raw.at };
  if (!verifies(REVOKE_TAG, body, raw.sig, pinned))
    return { ok: false, reason: 'it is not signed by the pinned key' };
  return { ok: true, at: raw.at };
}
