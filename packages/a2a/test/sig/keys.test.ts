import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  a2aFingerprint,
  ecThumbprint,
  publicJwkOf,
  sas,
} from '../../src/sig/keys.js';

// RFC 9421 Appendix B.1.3, test-key-ecc-p256.
const TEST_KEY = {
  kty: 'EC',
  crv: 'P-256',
  d: 'UpuF81l-kOxbjf7T4mNSv0r5tN67Gim7rnf6EFpcYDs',
  x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA',
  y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0',
};
// Computed outside this code (openssl and a separate Crockford encoder).
const TEST_THUMBPRINT = 'ydQXMtvbsOsZyFir-Y7A8t7fKEM1gbKPvyFkdpu4fvI';
const OTHER_THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

describe('card-key identity', () => {
  it('computes the RFC 7638 thumbprint of a P-256 key, and nothing for others', () => {
    expect(ecThumbprint(TEST_KEY)).toBe(TEST_THUMBPRINT);
    expect(ecThumbprint({ kty: 'OKP', crv: 'Ed25519', x: 'abc' })).toBeNull();
    expect(
      ecThumbprint({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' })
    ).toBeNull();
  });

  it('renders the fingerprint people compare as six groups of four', () => {
    expect(a2aFingerprint(TEST_THUMBPRINT)).toBe(
      'R1QW-FQW2-B1Y7-0CV4-9989-69F7'
    );
  });

  it('gives both sides the same short authentication string, bound to the pairing', () => {
    expect(sas(TEST_THUMBPRINT, OTHER_THUMBPRINT, 'pair-5')).toBe('5N82-A48G');
    expect(sas(OTHER_THUMBPRINT, TEST_THUMBPRINT, 'pair-5')).toBe('5N82-A48G');
    expect(sas(TEST_THUMBPRINT, OTHER_THUMBPRINT, 'pair-6')).not.toBe(
      '5N82-A48G'
    );
  });

  it('keeps only the public half of an EC P-256 key, and refuses any other key', () => {
    expect(publicJwkOf(TEST_KEY)).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: TEST_KEY.x,
      y: TEST_KEY.y,
    });
    const ed = generateKeyPairSync('ed25519').publicKey.export({
      format: 'jwk',
    }) as Record<string, string>;
    expect(() => publicJwkOf(ed)).toThrow();
    expect(() =>
      publicJwkOf({ ...TEST_KEY, x: 7 as unknown as string })
    ).toThrow();
  });
});
