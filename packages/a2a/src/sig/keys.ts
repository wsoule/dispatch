import { crockford32 } from '@dispatch/protocol/federation';
import { createHash } from 'node:crypto';

type JWK = Record<string, unknown>;

// RFC 7638 thumbprint of a P-256 public key; null for any other key.
export function ecThumbprint(jwk: JWK): string | null {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
}

function groups(digest: Buffer, bytes: number, count: number): string {
  const text = crockford32(digest.subarray(0, bytes));
  return (text.match(/.{4}/g) ?? []).slice(0, count).join('-');
}

/** What two people compare: a tagged hash of the card key's thumbprint. */
export function a2aFingerprint(thumbprint: string): string {
  return groups(
    createHash('sha256').update(`dispatch-a2a-fp-v1\n${thumbprint}`).digest(),
    15,
    6
  );
}

/** The short string both sides of one pairing show; order-free in its keys. */
export function sas(tpA: string, tpB: string, pairingId: string): string {
  const [lo, hi] = tpA < tpB ? [tpA, tpB] : [tpB, tpA];
  return groups(
    createHash('sha256')
      .update(`dispatch-a2a-sas-v1\n${lo}\n${hi}\n${pairingId}`)
      .digest(),
    5,
    2
  );
}

/** The public half of an EC P-256 JWK; throws for any other key. */
export function publicJwkOf(jwk: JWK): Record<string, string> {
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  )
    throw new TypeError('expected an EC P-256 key');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
