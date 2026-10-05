import { MessagingError } from '@dispatch/protocol';
import type { JsonValue } from '@dispatch/protocol';
import { canonicalize } from '@dispatch/protocol/federation';
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint, publicJwkOf } from '../sig/keys.js';
import type { KeyPin } from '../store/sqlite.js';
import type { Reach } from './reach.js';

// Symmetric pairing (P5): one code from the offering side, one proof back.
// Pure checks; the daemon fetches cards and writes rows.

export interface PairingCode {
  v: 1;
  // 16 random bytes: the pairing row's key.
  id: string;
  // 32 random bytes; the offering side keeps only sha256 of it.
  secret: string;
  // The offering side's card public key and its thumbprint: the accepter
  // checks the card and the signed reply against them.
  thumbprint: string;
  jwk: Record<string, string>;
  reach: Reach;
  // The offering side's display name: untrusted text on the other side.
  name: string;
  expires: string;
}

export interface PairingProof {
  v: 1;
  id: string;
  reach: Reach;
  name: string;
  // The accepter's card public key (EC P-256).
  jwk: Record<string, string>;
  nonce: string;
  // HMAC-SHA256 under sha256(secret), then ES256 by jwk, over the same bytes.
  mac: string;
  sig: string;
}

const PREFIX = 'dispatch-a2a-pair:';
const TAG = 'dispatch-a2a-pair-v1';
const MAX_CODE_CHARS = 2048;
const B64U = (len: number) => new RegExp(`^[A-Za-z0-9_-]{${len}}$`);
const ID = B64U(22);
const SECRET = B64U(43);
const THUMBPRINT = B64U(43);
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const MAC = B64U(43);
const SIG = B64U(86);
// One line of printable text, at most 100 characters, with no format
// characters (bidi overrides, zero-width joiners) that would disguise it.
const NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,100}$/u;
const MAX_LINK_BYTES = 4096;
const MAX_LINK_DEPTH = 8;

// JSON nesting below `depth` levels; stops at the first level too deep.
function shallow(v: unknown, depth: number): boolean {
  if (depth < 0) return false;
  if (typeof v !== 'object' || v === null) return true;
  return Object.values(v).every((x) => shallow(x, depth - 1));
}

const invalid = (why: string): never => {
  throw new MessagingError('invalid', `pairing code: ${why}`, 'code');
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A reach as a remote party wrote it: an http(s) card URL with no userinfo,
// or a link transport (validated by the link code, P5c).
function parseReach(raw: unknown): Reach | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'url' && typeof raw.card === 'string') {
    try {
      const u = new URL(raw.card);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (u.username !== '' || u.password !== '') return null;
      return { kind: 'url', card: u.href };
    } catch {
      return null;
    }
  }
  if (raw.kind === 'link' && isRecord(raw.transport)) {
    if (!shallow(raw.transport, MAX_LINK_DEPTH)) return null;
    let size: number;
    try {
      size = JSON.stringify(raw.transport).length;
    } catch {
      return null;
    }
    if (size > MAX_LINK_BYTES) return null;
    return {
      kind: 'link',
      transport: raw.transport as Record<string, JsonValue>,
    };
  }
  return null;
}

/** The secret's hash: what the offering side stores and keys the MAC with. */
function macKeyOf(secret: string): string {
  return createHash('sha256')
    .update(Buffer.from(secret, 'base64url'))
    .digest('base64url');
}

/**
 * A new code, and the value the offering side stores. That value is the MAC
 * key itself, so a reader of a2a.db could complete an open pairing within its
 * lifetime; the same local-access limit as XH-R7.
 */
export function newPairingCode(i: {
  jwk: Record<string, string>;
  reach: Reach;
  name: string;
  now: Date;
  ttlMin: number;
}): { code: PairingCode; secretHash: string } {
  const secret = randomBytes(32).toString('base64url');
  const code: PairingCode = {
    v: 1,
    id: randomBytes(16).toString('base64url'),
    secret,
    thumbprint: ecThumbprint(i.jwk) ?? '',
    jwk: publicJwkOf(i.jwk),
    reach: i.reach,
    name: i.name,
    expires: new Date(i.now.getTime() + i.ttlMin * 60_000).toISOString(),
  };
  return { code, secretHash: macKeyOf(secret) };
}

export function encodePairingCode(c: PairingCode): string {
  return `${PREFIX}${Buffer.from(canonicalize(c as unknown as JsonValue)).toString('base64url')}`;
}

/** The code as the accepter typed it; MessagingError('invalid') on any defect or once expired. */
export function decodePairingCode(text: string, now: Date): PairingCode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX) || trimmed.length > MAX_CODE_CHARS)
    invalid('not a Dispatch pairing code');
  const body = trimmed.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) invalid('not a Dispatch pairing code');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return invalid('not a Dispatch pairing code');
  }
  if (!isRecord(raw) || raw.v !== 1) return invalid('an unknown version');
  const reach = parseReach(raw.reach);
  const expires =
    typeof raw.expires === 'string' ? Date.parse(raw.expires) : Number.NaN;
  if (
    typeof raw.id !== 'string' ||
    !ID.test(raw.id) ||
    typeof raw.secret !== 'string' ||
    !SECRET.test(raw.secret) ||
    typeof raw.thumbprint !== 'string' ||
    !THUMBPRINT.test(raw.thumbprint) ||
    typeof raw.name !== 'string' ||
    !NAME.test(raw.name) ||
    reach === null ||
    Number.isNaN(expires)
  )
    return invalid('a malformed code');
  let jwk: Record<string, string>;
  try {
    jwk = publicJwkOf(isRecord(raw.jwk) ? raw.jwk : {});
  } catch {
    return invalid('a malformed code');
  }
  if (ecThumbprint(jwk) !== raw.thumbprint)
    return invalid('its key does not match its fingerprint');
  if (expires <= now.getTime()) return invalid('this code has expired');
  return {
    v: 1,
    id: raw.id,
    secret: raw.secret,
    thumbprint: raw.thumbprint,
    jwk,
    reach,
    name: raw.name,
    expires: raw.expires as string,
  };
}

// The bytes the MAC and the signature both cover.
function proofBytes(p: Omit<PairingProof, 'mac' | 'sig'>): Buffer {
  return Buffer.from(
    `${TAG}\n${canonicalize({
      v: p.v,
      id: p.id,
      reach: p.reach as unknown as JsonValue,
      name: p.name,
      jwk: p.jwk,
      nonce: p.nonce,
    })}`
  );
}

export function makeProof(i: {
  code: PairingCode;
  reach: Reach;
  name: string;
  privateKey: KeyObject;
  jwk: Record<string, string>;
}): PairingProof {
  const unsigned = {
    v: 1 as const,
    id: i.code.id,
    reach: i.reach,
    name: i.name,
    jwk: publicJwkOf(i.jwk),
    nonce: randomBytes(16).toString('base64url'),
  };
  const bytes = proofBytes(unsigned);
  const mac = createHmac(
    'sha256',
    Buffer.from(macKeyOf(i.code.secret), 'base64url')
  )
    .update(bytes)
    .digest('base64url');
  const sig = sign('sha256', bytes, {
    key: i.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { ...unsigned, mac, sig };
}

/** Whether a pairing row still takes a proof. */
export function pairingStatus(
  row: { state: string; expiresAt: string },
  now: Date
): 'open' | 'completed' | 'canceled' | 'expired' {
  if (row.state === 'completed') return 'completed';
  if (row.state !== 'offered') return 'canceled';
  return Date.parse(row.expiresAt) <= now.getTime() ? 'expired' : 'open';
}

function parseProof(raw: unknown): PairingProof | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const reach = parseReach(raw.reach);
  if (
    reach === null ||
    typeof raw.id !== 'string' ||
    !ID.test(raw.id) ||
    typeof raw.name !== 'string' ||
    !NAME.test(raw.name) ||
    typeof raw.nonce !== 'string' ||
    !NONCE.test(raw.nonce) ||
    typeof raw.mac !== 'string' ||
    !MAC.test(raw.mac) ||
    typeof raw.sig !== 'string' ||
    !SIG.test(raw.sig) ||
    !isRecord(raw.jwk)
  )
    return null;
  let jwk: Record<string, string>;
  try {
    jwk = publicJwkOf(raw.jwk);
  } catch {
    return null;
  }
  return {
    v: 1,
    id: raw.id,
    reach,
    name: raw.name,
    jwk,
    nonce: raw.nonce,
    mac: raw.mac,
    sig: raw.sig,
  };
}

/**
 * Checks a proof against the offering side's row: 'not-found' for a pairing
 * that is not open (or another id), 'invalid' for a bad shape, MAC or
 * signature. Never throws.
 */
export function checkProof(
  raw: unknown,
  row: {
    id: string;
    secretHash: string | null;
    expiresAt: string;
    state: string;
  },
  now: Date
):
  | { ok: true; proof: PairingProof; thumbprint: string }
  | { ok: false; reason: 'not-found' | 'invalid' } {
  const proof = parseProof(raw);
  if (proof === null) return { ok: false, reason: 'invalid' };
  if (
    proof.id !== row.id ||
    pairingStatus(row, now) !== 'open' ||
    row.secretHash === null
  )
    return { ok: false, reason: 'not-found' };
  let bytes: Buffer;
  try {
    bytes = proofBytes(proof);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const expected = createHmac(
    'sha256',
    Buffer.from(row.secretHash, 'base64url')
  )
    .update(bytes)
    .digest();
  const presented = Buffer.from(proof.mac, 'base64url');
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  )
    return { ok: false, reason: 'invalid' };
  let signed = false;
  try {
    signed = verify(
      'sha256',
      bytes,
      {
        key: createPublicKey({ key: proof.jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(proof.sig, 'base64url')
    );
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: 'invalid' };
  const thumbprint = ecThumbprint(proof.jwk);
  if (thumbprint === null) return { ok: false, reason: 'invalid' };
  return { ok: true, proof, thumbprint };
}

/** The key pin a completed pairing writes on both of this side's rows. */
export function pairingPin(
  peer: { thumbprint: string; jwk: Record<string, string> },
  pairingId: string,
  auth: 'signature' | 'link'
): KeyPin {
  return {
    thumbprint: peer.thumbprint,
    jwk: peer.jwk,
    auth,
    pairedId: pairingId,
  };
}
