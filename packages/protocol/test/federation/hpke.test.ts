import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  aeadSeal,
  decap,
  encap,
  keySchedule,
  nonceFor,
  x25519Private,
} from '../../src/federation/hpke.js';

interface Vector {
  mode: number;
  kem_id: number;
  kdf_id: number;
  aead_id: number;
  info: string;
  skEm: string;
  skRm: string;
  pkEm: string;
  pkRm: string;
  enc: string;
  shared_secret: string;
  key: string;
  base_nonce: string;
  encryptions: { aad: string; ct: string; nonce: string; pt: string }[];
}
const load = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
  ) as Vector;
const hex = (s: string) => Buffer.from(s, 'hex');

describe('HPKE base mode, DHKEM(X25519, HKDF-SHA256)', () => {
  it('matches the CFRG vector for X25519, HKDF-SHA256, AES-256-GCM, every encryption', () => {
    const v = load('hpke-x25519-sha256-aes256gcm.json');
    expect([v.mode, v.kem_id, v.kdf_id, v.aead_id]).toEqual([0, 32, 1, 2]);
    const pkR = hex(v.pkRm);
    const { sharedSecret, enc } = encap(pkR, {
      privateKey: x25519Private(hex(v.skEm), hex(v.pkEm)),
      publicRaw: hex(v.pkEm),
    });
    expect(enc.toString('hex')).toBe(v.enc);
    expect(sharedSecret.toString('hex')).toBe(v.shared_secret);
    expect(
      decap(enc, x25519Private(hex(v.skRm), pkR), pkR).toString('hex')
    ).toBe(v.shared_secret);
    const { key, baseNonce } = keySchedule(sharedSecret, hex(v.info));
    expect(key.toString('hex')).toBe(v.key);
    expect(baseNonce.toString('hex')).toBe(v.base_nonce);
    expect(v.encryptions).toHaveLength(257);
    v.encryptions.forEach((e, seq) => {
      const nonce = nonceFor(baseNonce, seq);
      expect(nonce.toString('hex')).toBe(e.nonce);
      expect(aeadSeal(key, nonce, hex(e.aad), hex(e.pt)).toString('hex')).toBe(
        e.ct
      );
    });
  });

  it('matches the RFC 9180 A.1 KEM (X25519 with AES-128-GCM) as an extra KEM check', () => {
    const v = load('hpke-x25519-sha256-aes128gcm.json');
    const pkR = hex(v.pkRm);
    const { sharedSecret } = encap(pkR, {
      privateKey: x25519Private(hex(v.skEm), hex(v.pkEm)),
      publicRaw: hex(v.pkEm),
    });
    expect(sharedSecret.toString('hex')).toBe(v.shared_secret);
  });
});
