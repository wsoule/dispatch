// RFC 9180 base mode for DHKEM(X25519) 0x0020, HKDF-SHA256 0x0001, AES-256-GCM
// 0x0002. Labeled HKDF uses createHmac, since hkdfSync fuses extract and expand.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { fromB64u } from './encoding.js';
import { publicKeyOf } from './keys.js';

const i2osp2 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp2(0x0020)]);
const HPKE_SUITE = Buffer.concat([
  Buffer.from('HPKE'),
  i2osp2(0x0020),
  i2osp2(0x0001),
  i2osp2(0x0002),
]);
const V1 = Buffer.from('HPKE-v1');
const NH = 32;
const NK = 32;
const NN = 12;
const TAG_BYTES = 16;
const EMPTY = Buffer.alloc(0);

function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt.length === 0 ? Buffer.alloc(NH) : salt)
    .update(ikm)
    .digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let t = EMPTY;
  for (let i = 1; blocks.length * NH < length; i++) {
    t = createHmac('sha256', prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest();
    blocks.push(t);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

function labeledExtract(
  suite: Buffer,
  salt: Buffer,
  label: string,
  ikm: Buffer
): Buffer {
  return extract(salt, Buffer.concat([V1, suite, Buffer.from(label), ikm]));
}

function labeledExpand(
  suite: Buffer,
  prk: Buffer,
  label: string,
  info: Buffer,
  length: number
): Buffer {
  return expand(
    prk,
    Buffer.concat([i2osp2(length), V1, suite, Buffer.from(label), info]),
    length
  );
}

function x25519Public(raw: Buffer): KeyObject {
  return publicKeyOf(raw.toString('base64url'), 'X25519');
}

// For vectors, which give raw keys: a private X25519 key from its raw bytes.
export function x25519Private(raw: Buffer, publicRaw: Buffer): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: raw.toString('base64url'),
      x: publicRaw.toString('base64url'),
    },
    format: 'jwk',
  });
}

interface Ephemeral {
  privateKey: KeyObject;
  publicRaw: Buffer;
}

function freshEphemeral(): Ephemeral {
  const pair = generateKeyPairSync('x25519');
  const { x } = pair.publicKey.export({ format: 'jwk' });
  if (typeof x !== 'string') throw new Error('expected an OKP public key');
  return { privateKey: pair.privateKey, publicRaw: fromB64u(x) };
}

function sharedSecretOf(dh: Buffer, enc: Buffer, pkR: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh);
  return labeledExpand(
    KEM_SUITE,
    eaePrk,
    'shared_secret',
    Buffer.concat([enc, pkR]),
    NH
  );
}

// The ephemeral key is fresh unless a test vector supplies one.
export function encap(
  pkR: Buffer,
  ephemeral: Ephemeral = freshEphemeral()
): { sharedSecret: Buffer; enc: Buffer } {
  const dh = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519Public(pkR),
  });
  return {
    sharedSecret: sharedSecretOf(dh, ephemeral.publicRaw, pkR),
    enc: ephemeral.publicRaw,
  };
}

export function decap(enc: Buffer, skR: KeyObject, pkR: Buffer): Buffer {
  const dh = diffieHellman({ privateKey: skR, publicKey: x25519Public(enc) });
  return sharedSecretOf(dh, enc, pkR);
}

export function keySchedule(
  sharedSecret: Buffer,
  info: Buffer
): { key: Buffer; baseNonce: Buffer } {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, NK),
    baseNonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, NN),
  };
}

// base_nonce XOR I2OSP(seq, Nn); the vectors check every step from 0 to 256.
export function nonceFor(baseNonce: Buffer, seq: number): Buffer {
  const nonce = Buffer.from(baseNonce);
  let rest = seq;
  for (let i = nonce.length - 1; i >= 0 && rest > 0; i--) {
    nonce.writeUInt8(nonce.readUInt8(i) ^ (rest & 0xff), i);
    rest = Math.floor(rest / 256);
  }
  return nonce;
}

// AES-256-GCM with its 16-byte tag appended to the ciphertext.
export function aeadSeal(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  pt: Buffer
): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

// Throws when the tag does not verify.
export function aeadOpen(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  ct: Buffer
): Buffer {
  if (ct.length < TAG_BYTES) throw new RangeError('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  return Buffer.concat([
    d.update(ct.subarray(0, ct.length - TAG_BYTES)),
    d.final(),
  ]);
}

// Single-shot: one context seals exactly once, at sequence 0.
export function sealBase(
  pkR: Buffer,
  info: Buffer,
  pt: Buffer
): { enc: Buffer; ct: Buffer } {
  const { sharedSecret, enc } = encap(pkR);
  const { key, baseNonce } = keySchedule(sharedSecret, info);
  return { enc, ct: aeadSeal(key, baseNonce, EMPTY, pt) };
}

export function openBase(
  enc: Buffer,
  skR: KeyObject,
  pkR: Buffer,
  info: Buffer,
  ct: Buffer
): Buffer {
  const { key, baseNonce } = keySchedule(decap(enc, skR, pkR), info);
  return aeadOpen(key, baseNonce, EMPTY, ct);
}
