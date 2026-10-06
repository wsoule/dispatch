import { verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { SigBaseError, signatureBase } from './base.js';
import type { RequestParts } from './base.js';
import { digestMatches } from './digest.js';
import { isInnerList, parseDictionary, serializeItem } from './sf.js';
import type { InnerList } from './sf.js';
import {
  requestComponents,
  responseItems,
  SIG_ALG,
  SIG_LIFETIME_S,
  SIG_TAG,
} from './sign.js';

export type SigRefusal =
  | 'sig_missing'
  | 'sig_malformed'
  | 'sig_key_unknown'
  | 'sig_stale'
  | 'sig_digest'
  | 'sig_bad'
  | 'sig_replay'
  | 'sig_busy';

export type SigResult =
  | { ok: true; keyid: string }
  // keyid is set when the signature itself verified (a replay, a busy key).
  | { ok: false; reason: SigRefusal; keyid?: string };

export interface VerifyFacts {
  // The origin this verifier is configured to serve: never Host or X-Forwarded-*.
  configuredOrigin: string;
  // Pinned keys only.
  keyFor(keyid: string): KeyObject | null;
  now: Date;
  guardMs: number;
  rememberNonce(
    keyid: string,
    nonce: string,
    expiresAt: Date
  ): 'fresh' | 'replay' | 'full';
}

const refuse = (reason: SigRefusal): SigResult => ({ ok: false, reason });
// Dispatch writes 16 random bytes; anything shorter guesses, anything longer bloats the cache.
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const PATH = /^\/[^?#]*$/;
const QUERY = /^(?:\?[^#]*)?$/;
const EMPTY = new Uint8Array(0);

// The configured origin as scheme://host[:port], or null when it is more than that.
function bareOrigin(configured: string): string | null {
  let u: URL;
  try {
    u = new URL(configured);
  } catch {
    return null;
  }
  if (
    u.username !== '' ||
    u.password !== '' ||
    u.search !== '' ||
    u.hash !== ''
  )
    return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (configured.includes('?') || configured.includes('#')) return null;
  return u.origin;
}

/** ECDSA P-256 over a signature base: r||s, 64 octets (RFC 9421 §3.3.4). */
export function verifyBase(
  base: string,
  signature: Uint8Array,
  key: KeyObject
): boolean {
  if (signature.length !== 64) return false;
  try {
    return verify(
      'sha256',
      Buffer.from(base),
      { key, dsaEncoding: 'ieee-p1363' },
      signature
    );
  } catch {
    return false;
  }
}

interface Tagged {
  covered: InnerList;
  signature: Uint8Array;
  keyid: string;
  created: number;
  expires: number;
  nonce: string;
}

// The one signature tagged for Dispatch; others (an intermediary's) are ignored.
function tagged(headers: Headers): Tagged | SigRefusal {
  const inputText = headers.get('signature-input');
  const sigText = headers.get('signature');
  if (inputText === null || sigText === null) return 'sig_missing';
  let inputs;
  let sigs;
  try {
    inputs = parseDictionary(inputText);
    sigs = parseDictionary(sigText);
  } catch {
    return 'sig_malformed';
  }
  const ours = [...inputs].filter(
    ([, m]) => isInnerList(m) && m.params.get('tag') === SIG_TAG
  );
  if (ours.length === 0) return 'sig_missing';
  if (ours.length > 1) return 'sig_malformed';
  const [label, member] = ours[0];
  const covered = member as InnerList;
  const sig = sigs.get(label);
  if (
    sig === undefined ||
    isInnerList(sig) ||
    !(sig.value instanceof Uint8Array)
  )
    return 'sig_malformed';
  const p = covered.params;
  const keyid = p.get('keyid');
  const created = p.get('created');
  const expires = p.get('expires');
  const nonce = p.get('nonce');
  if (
    p.get('alg') !== SIG_ALG ||
    typeof keyid !== 'string' ||
    typeof nonce !== 'string' ||
    !NONCE.test(nonce) ||
    typeof created !== 'number' ||
    typeof expires !== 'number' ||
    !Number.isInteger(created) ||
    !Number.isInteger(expires) ||
    expires < created
  )
    return 'sig_malformed';
  return { covered, signature: sig.value, keyid, created, expires, nonce };
}

function covers(covered: InnerList, required: string[]): boolean {
  const have = new Set(covered.items.map(serializeItem));
  return required.every((id) => have.has(id));
}

function inWindow(t: Tagged, now: Date, guardMs: number): boolean {
  const createdMs = t.created * 1000;
  return (
    Math.abs(now.getTime() - createdMs) <= guardMs &&
    t.expires * 1000 > now.getTime() &&
    t.expires - t.created <= SIG_LIFETIME_S
  );
}

function isP256(key: KeyObject): boolean {
  return (
    key.asymmetricKeyType === 'ec' &&
    key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
  );
}

// Checks shared by requests and responses, in the order that spends the
// least on a forgery: shape, window, key, digest, base, signature.
function check(
  t: Tagged,
  required: string[],
  f: { keyFor(keyid: string): KeyObject | null; now: Date; guardMs: number },
  body: Uint8Array | null,
  headers: Headers,
  build: () => string
): SigResult {
  if (
    !covers(
      t.covered,
      required.map((n) => serializeItem({ value: n, params: new Map() }))
    )
  )
    return refuse('sig_malformed');
  if (!inWindow(t, f.now, f.guardMs)) return refuse('sig_stale');
  const key = f.keyFor(t.keyid);
  if (key === null) return refuse('sig_key_unknown');
  if (!isP256(key)) return refuse('sig_malformed');
  let base: string;
  try {
    base = build();
  } catch (err) {
    if (err instanceof SigBaseError) return refuse('sig_malformed');
    throw err;
  }
  const digestCovered = t.covered.items.some(
    (i) => i.value === 'content-digest' && i.params.size === 0
  );
  if (
    digestCovered &&
    !digestMatches(headers.get('content-digest'), body ?? EMPTY)
  )
    return refuse('sig_digest');
  if (!verifyBase(base, t.signature, key)) return refuse('sig_bad');
  return { ok: true, keyid: t.keyid };
}

export interface ReceivedRequest {
  method: string;
  path: string;
  // '' or '?…', exactly as received.
  query: string;
  headers: Headers;
  body: Uint8Array | null;
}

/**
 * Whether `path` is already in normal form: no `.` or `..` segment, raw or
 * percent-encoded in any case, so what a host routes on is what was signed
 * (relay re-review I1). A URL round trip must give it back unchanged.
 */
export function normalizedPath(path: string): boolean {
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)) return false;
  try {
    return new URL(path, 'http://normal.invalid').pathname === path;
  } catch {
    return false;
  }
}

/** Verifies a request against the configured origin, then spends its nonce. */
export function verifyRequest(req: ReceivedRequest, f: VerifyFacts): SigResult {
  const origin = bareOrigin(f.configuredOrigin);
  if (
    origin === null ||
    !PATH.test(req.path) ||
    !normalizedPath(req.path) ||
    !QUERY.test(req.query)
  )
    return refuse('sig_malformed');
  const t = tagged(req.headers);
  if (typeof t === 'string') return refuse(t);
  const targetUri = `${origin}${req.path}${req.query}`;
  const result = check(
    t,
    requestComponents(req.body !== null),
    f,
    req.body,
    req.headers,
    () =>
      signatureBase(t.covered, {
        request: { method: req.method, targetUri, headers: req.headers },
      })
  );
  if (!result.ok) return result;
  const seen = f.rememberNonce(
    t.keyid,
    t.nonce,
    new Date(t.expires * 1000 + f.guardMs)
  );
  if (seen === 'replay')
    return { ok: false, reason: 'sig_replay', keyid: t.keyid };
  if (seen === 'full') return { ok: false, reason: 'sig_busy', keyid: t.keyid };
  return result;
}

/** Verifies a response against the request this side sent. */
export function verifyResponse(
  res: { status: number; headers: Headers; body: Uint8Array | null },
  request: RequestParts,
  f: { keyFor(keyid: string): KeyObject | null; now: Date; guardMs: number }
): SigResult {
  const t = tagged(res.headers);
  if (typeof t === 'string') return refuse(t);
  const required = responseItems(
    res.body !== null,
    request.headers,
    res.headers.has('content-type')
  ).map((item) => serializeItem(item));
  const have = new Set(t.covered.items.map(serializeItem));
  if (!required.every((id) => have.has(id))) return refuse('sig_malformed');
  return check(t, [], f, res.body, res.headers, () =>
    signatureBase(t.covered, {
      response: { status: res.status, headers: res.headers },
      request,
    })
  );
}
