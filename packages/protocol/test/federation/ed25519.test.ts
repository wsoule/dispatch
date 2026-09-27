import { describe, expect, it } from 'bun:test';
import { createPrivateKey, sign } from 'node:crypto';

import { b64u } from '../../src/federation/encoding.js';
import { fingerprint } from '../../src/federation/fingerprint.js';
import {
  ed25519FromSeed,
  generateReplicaKeys,
  publicOfPrivate,
  signText,
  verifyText,
} from '../../src/federation/keys.js';

// RFC 8032 §7.1, TEST 1 (the empty message).
const SECRET =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('Ed25519 through node:crypto', () => {
  it('reproduces RFC 8032 TEST 1', () => {
    const key = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: b64u(Buffer.from(SECRET, 'hex')),
        x: b64u(Buffer.from(PUBLIC, 'hex')),
      },
      format: 'jwk',
    });
    expect(sign(null, Buffer.alloc(0), key).toString('hex')).toBe(SIGNATURE);
    const fromSeed = ed25519FromSeed(Buffer.from(SECRET, 'hex'));
    expect(Buffer.from(fromSeed.signPub, 'base64url').toString('hex')).toBe(
      PUBLIC
    );
    expect(
      verifyText(fromSeed.signPub, '', b64u(Buffer.from(SIGNATURE, 'hex')))
    ).toBe(true);
  });

  it('generates raw 32-byte publics and signs text round trip', () => {
    const keys = generateReplicaKeys();
    expect(Buffer.from(keys.signPub, 'base64url')).toHaveLength(32);
    expect(Buffer.from(keys.sealPub, 'base64url')).toHaveLength(32);
    expect(publicOfPrivate(keys.signPriv)).toBe(keys.signPub);
    const sig = signText(keys.signPriv, 'dispatch-op-v2\n{}');
    expect(verifyText(keys.signPub, 'dispatch-op-v2\n{}', sig)).toBe(true);
    expect(verifyText(keys.signPub, 'dispatch-op-v2\n{ }', sig)).toBe(false);
    expect(verifyText(keys.signPub, 'x', 'not base64url!')).toBe(false);
  });

  it('refuses a second signature made by adding the group order to S', () => {
    const keys = generateReplicaKeys();
    const sig = Buffer.from(signText(keys.signPriv, 'x'), 'base64url');
    const order = (1n << 252n) + 27742317777372353535851937790883648493n;
    // S is the little-endian second half of the signature.
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig.readUInt8(i));
    let raised = s + order;
    for (let i = 32; i < 64; i++) {
      sig.writeUInt8(Number(raised & 0xffn), i);
      raised >>= 8n;
    }
    expect(verifyText(keys.signPub, 'x', b64u(sig))).toBe(false);
  });

  it('prints a fingerprint as six groups of four Crockford characters', () => {
    const keys = generateReplicaKeys();
    const printed = fingerprint(keys.signPub, keys.sealPub);
    expect(printed).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
    // Crockford's alphabet leaves out I, L, O and U.
    for (const left of ['I', 'L', 'O', 'U'])
      expect(printed).not.toContain(left);
    expect(printed).toBe(fingerprint(keys.signPub, keys.sealPub));
  });
});
