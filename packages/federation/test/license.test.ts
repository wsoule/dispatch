import { describe, expect, test } from 'bun:test';

import {
  FREE_SEATS,
  LICENSE_PUBLIC_KEY,
  readLicenseKey,
} from '../src/license.js';
import { licenseFor, testKeys } from './licenseKeys.js';

// Every way a license key can be wrong lands on the free plan with a reason —
// never a crash, never a lockout — and only a key signed by the licensor
// raises the seat count.

const NOW = new Date('2026-09-23T12:00:00Z');

describe('readLicenseKey', () => {
  const keys = testKeys();

  test('a key signed by the licensor grants its seats', () => {
    const state = readLicenseKey(
      licenseFor(keys.privateKey, { org: 'Acme', seats: 12 }),
      keys.publicKey,
      NOW
    );
    expect(state).toMatchObject({
      kind: 'licensed',
      seats: 12,
      license: { org: 'Acme' },
    });
  });

  test('a key never covers fewer people than the free plan', () => {
    const state = readLicenseKey(
      licenseFor(keys.privateKey, { seats: 1 }),
      keys.publicKey,
      NOW
    );
    expect(state.seats).toBe(FREE_SEATS);
  });

  test('an expired key falls back to the free plan, keeping the license', () => {
    const state = readLicenseKey(
      licenseFor(keys.privateKey, {
        seats: 40,
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
      keys.publicKey,
      NOW
    );
    expect(state).toMatchObject({
      kind: 'expired',
      seats: FREE_SEATS,
      license: { seats: 40, expiresAt: '2026-09-01T00:00:00.000Z' },
    });
  });

  test('a key signed by anyone else is not a license', () => {
    const forged = licenseFor(testKeys().privateKey, { seats: 999 });
    expect(readLicenseKey(forged, keys.publicKey, NOW)).toEqual({
      kind: 'invalid',
      seats: FREE_SEATS,
      reason: 'the signature does not match',
    });
  });

  test('editing the payload of a real key breaks its signature', () => {
    const [prefix, , signature] = licenseFor(keys.privateKey, {
      seats: 5,
    }).split('.');
    const inflated = Buffer.from(
      JSON.stringify({
        org: 'Acme',
        seats: 5000,
        issuedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null,
      })
    ).toString('base64url');
    expect(
      readLicenseKey(`${prefix}.${inflated}.${signature}`, keys.publicKey, NOW)
        .kind
    ).toBe('invalid');
  });

  test('garbage, and a build with no public key, read as the free plan', () => {
    for (const junk of ['', 'hello', 'dispatch1.a', 'dispatch1.!!.??']) {
      expect(readLicenseKey(junk, keys.publicKey, NOW)).toMatchObject({
        kind: 'invalid',
        seats: FREE_SEATS,
      });
    }
    expect(
      readLicenseKey(licenseFor(keys.privateKey), null, NOW)
    ).toMatchObject({ kind: 'invalid', seats: FREE_SEATS });
  });

  test('this build verifies against the one public key it ships', () => {
    expect(
      readLicenseKey(licenseFor(keys.privateKey), LICENSE_PUBLIC_KEY, NOW).kind
    ).toBe('invalid');
  });
});
