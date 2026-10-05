import type { CardInputs, CardSignatureJson, Jwks } from '@dispatch/a2a';
import {
  JWKS_PATH,
  signCard,
  unsignedCardEtag,
  unsignedCardJson,
} from '@dispatch/a2a';
import { readA2ASigningKey, writeA2ASigningKey } from '@dispatch/core';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

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

const UNUSABLE =
  'the stored card-signing key is not a usable ES256 private key';

// The public half of a private JWK, proven usable: the key must import as
// P-256, and a test signature made with d must verify under x and y.
function publicHalf(jwk: Record<string, string>): { x: string; y: string } {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error(UNUSABLE);
  try {
    const priv = createPrivateKey({ key: jwk, format: 'jwk' });
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      format: 'jwk',
    });
    const probe = Buffer.from('dispatch card-signing key check');
    if (!verify('sha256', probe, pub, sign('sha256', probe, priv)))
      throw new Error(UNUSABLE);
  } catch {
    throw new Error(UNUSABLE);
  }
  return { x: jwk.x, y: jwk.y };
}

// The card-signing key (spec:791-794): ES256, made once per project and kept
// in the 0600 credentials file. A key is made only when the slot is absent:
// a malformed slot, an unusable key or an unreadable file turn signing off
// instead. Losing the credentials file makes a new key, so the kid rotates.
// Errors never quote the key.
export function loadOrCreateSigningKey(rootDir: string): SigningKey {
  const read = readA2ASigningKey(rootDir);
  if (read.status === 'unreadable')
    throw new Error(
      'the credentials file cannot be parsed; no key is made until it is fixed'
    );
  if (read.status === 'malformed')
    throw new Error('the stored card-signing key is malformed');
  let jwk: Record<string, string>;
  if (read.status === 'ok') {
    jwk = read.jwk;
  } else {
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    }) as Record<string, string>;
    writeA2ASigningKey(rootDir, jwk);
  }
  const { x, y } = publicHalf(jwk);
  const publicJwk = { kty: 'EC', crv: 'P-256', x, y };
  const kid = thumbprint(publicJwk);
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', x, y, d: jwk.d, kid, alg: 'ES256' },
    publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
    kid,
  };
}

// Signs each distinct card once (ES256 signatures are randomized, and
// re-signing would churn every cache); a few cards are live at a time.
export class CardSigner {
  private readonly cache = new Map<string, CardSignatureJson[]>();
  private privateKey: KeyObject | undefined;
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

  // The same key signs requests and responses to paired peers (RFC 9421).
  requestKey(): { keyid: string; privateKey: KeyObject } {
    this.privateKey ??= createPrivateKey({
      key: this.key.privateJwk,
      format: 'jwk',
    });
    return { keyid: this.key.kid, privateKey: this.privateKey };
  }

  /** Public keys only. */
  jwks(): Jwks {
    return { keys: [{ ...this.key.publicJwk }] };
  }
}
