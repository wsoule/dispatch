import type { CardInputs, CardSignatureJson, Jwks } from '@dispatch/a2a';
import {
  JWKS_PATH,
  signCard,
  unsignedCardEtag,
  unsignedCardJson,
} from '@dispatch/a2a';
import { readA2ASigningKey, writeA2ASigningKey } from '@dispatch/core';
import { createHash, generateKeyPairSync } from 'node:crypto';

export interface SigningKey {
  privateJwk: Record<string, string>;
  publicJwk: Record<string, string>;
  kid: string;
}

// RFC 7638: sha256 over the required members in lexicographic order.
function thumbprint(pub: {
  crv: string;
  kty: string;
  x: string;
  y: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y }))
    .digest('base64url');
}

// The card-signing key (spec:791-794): ES256, made once per project and kept
// in the 0600 credentials file. Errors never quote the key.
export function loadOrCreateSigningKey(rootDir: string): SigningKey {
  let jwk = readA2ASigningKey(rootDir);
  if (jwk === null) {
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    }) as Record<string, string>;
    writeA2ASigningKey(rootDir, jwk);
  }
  const { kty, crv, x, y, d } = jwk;
  const filled = (v: string | undefined): v is string =>
    v !== undefined && v !== '';
  if (kty !== 'EC' || crv !== 'P-256' || !filled(d) || !filled(x) || !filled(y))
    throw new Error('the stored card-signing key is not an ES256 private key');
  const publicJwk = { kty, crv, x, y };
  const kid = thumbprint(publicJwk);
  return {
    privateJwk: { kty, crv, x, y, d, kid, alg: 'ES256' },
    publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
    kid,
  };
}

// Signs each distinct card once (ES256 signatures are randomized, and
// re-signing would churn every cache); a few cards are live at a time.
export class CardSigner {
  private readonly cache = new Map<string, CardSignatureJson[]>();
  constructor(private readonly key: SigningKey) {}

  async signaturesFor(inputs: CardInputs): Promise<CardSignatureJson[]> {
    const id = `${unsignedCardEtag(inputs)} ${inputs.publicUrl}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const signatures = await signCard(unsignedCardJson(inputs), {
      privateJwk: this.key.privateJwk,
      kid: this.key.kid,
      jku: `${inputs.publicUrl.replace(/\/$/, '')}${JWKS_PATH}`,
    });
    if (this.cache.size >= 8) this.cache.clear();
    this.cache.set(id, signatures);
    return signatures;
  }

  /** Public keys only. */
  jwks(): Jwks {
    return { keys: [{ ...this.key.publicJwk }] };
  }
}
