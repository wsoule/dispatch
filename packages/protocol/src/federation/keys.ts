import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { b64u, fromB64u } from './encoding.js';

// The fixed PKCS8 prefix of an Ed25519 private key; the 32-byte seed follows.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

// Privates are PKCS8 DER in base64url; publics are the raw 32 bytes in base64url.
export interface ReplicaKeys {
  signPriv: string;
  signPub: string;
  sealPriv: string;
  sealPub: string;
}

function rawPublic(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('expected an OKP public key');
  return jwk.x;
}

export function generateReplicaKeys(): ReplicaKeys {
  const s = generateKeyPairSync('ed25519');
  const x = generateKeyPairSync('x25519');
  return {
    signPriv: s.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url'),
    signPub: rawPublic(s.publicKey),
    sealPriv: x.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url'),
    sealPub: rawPublic(x.publicKey),
  };
}

// For recovery and invite codes, which carry only a seed.
export function ed25519FromSeed(seed: Uint8Array): {
  signPriv: string;
  signPub: string;
} {
  const der = Buffer.concat([ED25519_PKCS8, Buffer.from(seed)]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return {
    signPriv: der.toString('base64url'),
    signPub: rawPublic(createPublicKey(key)),
  };
}

export function privateKeyOf(der: string): KeyObject {
  return createPrivateKey({ key: fromB64u(der), format: 'der', type: 'pkcs8' });
}

export function publicKeyOf(raw: string, crv: 'Ed25519' | 'X25519'): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv, x: raw }, format: 'jwk' });
}

// Works for Ed25519 and X25519 alike: both export `x` in JWK.
export function publicOfPrivate(der: string): string {
  return rawPublic(createPublicKey(privateKeyOf(der)));
}

export function signText(signPriv: string, text: string): string {
  return b64u(sign(null, Buffer.from(text, 'utf8'), privateKeyOf(signPriv)));
}

// Never throws: a malformed key or signature is simply not a valid signature.
export function verifyText(
  signPub: string,
  text: string,
  sig: string
): boolean {
  try {
    return verify(
      null,
      Buffer.from(text, 'utf8'),
      publicKeyOf(signPub, 'Ed25519'),
      fromB64u(sig)
    );
  } catch {
    return false;
  }
}
