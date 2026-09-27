import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FREE_SEATS,
  LicenseManager,
  readLicenseKey,
  seatLimitMessage,
} from '../../src/team/license.js';
import { licenseFor, testKeys } from './licenseKeys.js';

// The key check itself is tested in @dispatch/federation; here, the manager
// that installs and reads keys, and the sentence a person sees at the limit.

const NOW = new Date('2026-09-23T12:00:00Z');

describe('seatLimitMessage', () => {
  const keys = testKeys();

  test('an expired key says when it expired', () => {
    const state = readLicenseKey(
      licenseFor(keys.privateKey, {
        seats: 40,
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
      keys.publicKey,
      NOW
    );
    expect(state).toMatchObject({ kind: 'expired', seats: FREE_SEATS });
    expect(seatLimitMessage(state.seats, state)).toContain(
      'expired on 2026-09-01'
    );
  });
});

describe('LicenseManager', () => {
  const keys = testKeys();
  const dir = () => mkdtempSync(join(tmpdir(), 'dispatch-license-'));

  test('with nothing installed it is the free plan', () => {
    const m = new LicenseManager({
      path: join(dir(), 'license.key'),
      publicKey: keys.publicKey,
    });
    expect(m.state()).toEqual({ kind: 'free', seats: FREE_SEATS });
  });

  test('installing a good key writes it 0600 and applies at once', () => {
    const path = join(dir(), 'license.key');
    const m = new LicenseManager({ path, publicKey: keys.publicKey });
    const key = licenseFor(keys.privateKey, { seats: 8 });
    expect(m.install(key).kind).toBe('licensed');
    expect(m.seats()).toBe(8);
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('a bad key is refused and the working one stays', () => {
    const path = join(dir(), 'license.key');
    const m = new LicenseManager({ path, publicKey: keys.publicKey });
    m.install(licenseFor(keys.privateKey, { seats: 8 }));
    expect(m.install('dispatch1.nope.nope').kind).toBe('invalid');
    expect(m.seats()).toBe(8);
  });

  test('a key from the environment wins over the file', () => {
    const path = join(dir(), 'license.key');
    writeFileSync(path, licenseFor(keys.privateKey, { seats: 8 }));
    const m = new LicenseManager({
      path,
      publicKey: keys.publicKey,
      envKey: licenseFor(keys.privateKey, { seats: 20 }),
    });
    expect(m.seats()).toBe(20);
  });

  test('an expiry passing takes effect without a restart', () => {
    let now = new Date('2026-09-23T12:00:00Z');
    const m = new LicenseManager({
      path: join(dir(), 'license.key'),
      publicKey: keys.publicKey,
      clock: () => now,
    });
    m.install(
      licenseFor(keys.privateKey, {
        seats: 8,
        expiresAt: '2026-10-01T00:00:00.000Z',
      })
    );
    expect(m.seats()).toBe(8);
    now = new Date('2026-10-02T00:00:00Z');
    expect(m.state().kind).toBe('expired');
    expect(m.seats()).toBe(FREE_SEATS);
  });
});
