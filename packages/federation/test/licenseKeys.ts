import { generateKeyPairSync } from 'node:crypto';

import type { License } from '../src/license.js';
import { signLicense } from '../src/license.js';

// Licenses for tests, signed with a key pair made here — never the real one,
// whose private half only the licensor holds.

export function testKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function licenseFor(
  privateKey: string,
  overrides: Partial<License> = {}
): string {
  return signLicense(
    {
      org: 'Acme',
      seats: 10,
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null,
      ...overrides,
    },
    privateKey
  );
}
