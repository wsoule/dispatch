import { createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint, publicJwkOf } from '../sig/keys.js';

/** The bytes a tenant's card key signs to join a relay. */
export function challengeString(
  relayUrl: string,
  thumbprint: string,
  nonce: string
): string {
  return `dispatch-a2a-relay-v1\n${relayUrl}\n${thumbprint}\n${nonce}`;
}

/** The daemon's `auth` frame for a relay's challenge, signed by its card key. */
export function answerChallenge(i: {
  relayUrl: string;
  nonce: string;
  privateKey: KeyObject;
  jwk: Record<string, string>;
}): {
  t: 'auth';
  thumbprint: string;
  jwk: Record<string, string>;
  sig: string;
} {
  const jwk = publicJwkOf(i.jwk);
  const thumbprint = ecThumbprint(jwk) ?? '';
  const sig = sign(
    'sha256',
    Buffer.from(challengeString(i.relayUrl, thumbprint, i.nonce)),
    { key: i.privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
  return { t: 'auth', thumbprint, jwk, sig };
}

/**
 * The relay's check of an `auth` frame: the key is the thumbprint's, the
 * thumbprint is allowlisted, and it signed this nonce for this relay URL.
 */
export function checkAuth(
  auth: { thumbprint: string; jwk: Record<string, string>; sig: string },
  relayUrl: string,
  nonce: string,
  allowed: (thumbprint: string) => boolean
): { ok: true; thumbprint: string } | { ok: false; reason: string } {
  let jwk: Record<string, string>;
  try {
    jwk = publicJwkOf(auth.jwk);
  } catch {
    return { ok: false, reason: 'not a P-256 key' };
  }
  if (ecThumbprint(jwk) !== auth.thumbprint)
    return { ok: false, reason: 'the key is not the thumbprint’s' };
  if (!allowed(auth.thumbprint))
    return { ok: false, reason: 'this tenant is not on the relay’s list' };
  let good = false;
  try {
    good = verify(
      'sha256',
      Buffer.from(challengeString(relayUrl, auth.thumbprint, nonce)),
      {
        key: createPublicKey({ key: jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(auth.sig, 'base64url')
    );
  } catch {
    good = false;
  }
  return good
    ? { ok: true, thumbprint: auth.thumbprint }
    : { ok: false, reason: 'the challenge signature does not verify' };
}
