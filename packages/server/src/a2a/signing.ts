import type { CardInputs, CardSignatureJson, Jwks } from '@dispatch/a2a';
import {
  JWKS_PATH,
  signCard,
  unsignedCardEtag,
  unsignedCardJson,
} from '@dispatch/a2a';
import {
  promoteA2ASigningKey,
  readA2ANextSigningKey,
  readA2ASigningKey,
  writeA2ASigningKey,
} from '@dispatch/core';
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
    jwk = newPrivateJwk();
    writeA2ASigningKey(rootDir, jwk);
  }
  return keyOf(jwk);
}

/** A fresh P-256 private JWK. */
export function newPrivateJwk(): Record<string, string> {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    format: 'jwk',
  }) as Record<string, string>;
}

// A stored private JWK as a signing key, proven usable.
function keyOf(jwk: Record<string, string>): SigningKey {
  const { x, y } = publicHalf(jwk);
  const publicJwk = { kty: 'EC', crv: 'P-256', x, y };
  const kid = thumbprint(publicJwk);
  return {
    privateJwk: { kty: 'EC', crv: 'P-256', x, y, d: jwk.d, kid, alg: 'ES256' },
    publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
    kid,
  };
}

/** A planned rotation's overlap: both keys sign and are served, then the old one goes. */
export const KEY_OVERLAP_MS = 7 * 24 * 3600 * 1000;

export interface SigningKeys {
  current: SigningKey;
  // A rotation in its overlap: the key it moves to, and when it began.
  next: { key: SigningKey; at: string } | null;
}

// The signing key and any rotation's next key; a rotation whose overlap is
// over is finished here, deleting the old key.
export function loadSigningKeys(
  rootDir: string,
  now = new Date()
): SigningKeys {
  const current = loadOrCreateSigningKey(rootDir);
  const read = readA2ANextSigningKey(rootDir);
  if (read.status === 'unreadable')
    throw new Error('the credentials file cannot be parsed');
  if (read.status === 'malformed')
    throw new Error("the stored rotation's next key is malformed");
  if (read.status === 'absent') return { current, next: null };
  const key = keyOf(read.next.jwk);
  const began = Date.parse(read.next.at);
  if (Number.isNaN(began) || now.getTime() - began >= KEY_OVERLAP_MS) {
    promoteA2ASigningKey(rootDir);
    return { current: key, next: null };
  }
  return { current, next: { key, at: read.next.at } };
}

// Signs each distinct card once (ES256 signatures are randomized, and
// re-signing would churn every cache); a few cards are live at a time.
export class CardSigner {
  private readonly cache = new Map<string, CardSignatureJson[]>();
  private readonly privateKeys = new Map<string, KeyObject>();
  private readonly keys: SigningKeys;
  constructor(keys: SigningKey | SigningKeys) {
    this.keys = 'current' in keys ? keys : { current: keys, next: null };
  }

  // The key that signs now: a rotation's new key through its overlap.
  private get active(): SigningKey {
    return this.keys.next?.key ?? this.keys.current;
  }

  /** The rotation in its overlap, if any: when it began. */
  rotationAt(): string | null {
    return this.keys.next?.at ?? null;
  }

  async signaturesFor(inputs: CardInputs): Promise<CardSignatureJson[]> {
    const id = `${unsignedCardEtag(inputs)} ${inputs.publicUrl}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const jku = `${inputs.publicUrl.replace(/\/$/, '')}${JWKS_PATH}`;
    // Through an overlap, both keys sign: peers pinned to either verify.
    const signers =
      this.keys.next === null
        ? [this.keys.current]
        : [this.keys.next.key, this.keys.current];
    const signatures: CardSignatureJson[] = [];
    for (const key of signers)
      signatures.push(
        ...(await signCard(unsignedCardJson(inputs), {
          privateJwk: key.privateJwk,
          kid: key.kid,
          jku,
        }))
      );
    if (this.cache.size >= 8) this.cache.clear();
    this.cache.set(id, signatures);
    return signatures;
  }

  private keyObject(key: SigningKey): { keyid: string; privateKey: KeyObject } {
    let privateKey = this.privateKeys.get(key.kid);
    if (privateKey === undefined) {
      privateKey = createPrivateKey({ key: key.privateJwk, format: 'jwk' });
      this.privateKeys.set(key.kid, privateKey);
    }
    return { keyid: key.kid, privateKey };
  }

  // The same key signs requests and responses to paired peers (RFC 9421).
  requestKey(): { keyid: string; privateKey: KeyObject } {
    return this.keyObject(this.active);
  }

  /** Through an overlap, the key being replaced: it signs the statement. */
  oldKey(): {
    keyid: string;
    privateKey: KeyObject;
    jwk: Record<string, string>;
  } | null {
    if (this.keys.next === null) return null;
    return {
      ...this.keyObject(this.keys.current),
      jwk: bareJwk(this.keys.current),
    };
  }

  /** The signing key itself, for a rotation to replace. */
  currentKey(): {
    keyid: string;
    privateKey: KeyObject;
    jwk: Record<string, string>;
  } {
    return {
      ...this.keyObject(this.keys.current),
      jwk: bareJwk(this.keys.current),
    };
  }

  // The active key's public half as a bare EC JWK (no kid, alg or use).
  publicJwk(): Record<string, string> {
    return bareJwk(this.active);
  }

  /** Public keys only: both through an overlap. */
  jwks(): Jwks {
    const keys = [{ ...this.active.publicJwk }];
    if (this.keys.next !== null) keys.push({ ...this.keys.current.publicJwk });
    return { keys };
  }
}

function bareJwk(key: SigningKey): Record<string, string> {
  const { kty, crv, x, y } = key.publicJwk;
  return { kty, crv, x, y };
}
