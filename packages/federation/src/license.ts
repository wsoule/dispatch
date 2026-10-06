import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// The license key check, shared by every daemon and the relay so both read a
// key the same way. Licensed under the Elastic License 2.0 (../LICENSE), whose
// terms forbid circumventing this functionality.
//
// A key that is missing, malformed, signed by anyone else, or expired never
// locks anyone out: it reads as the free tier, with the reason attached so
// Settings → License can say what is wrong.

/** People who may use Dispatch together without a license key. */
export const FREE_SEATS = 3;

/**
 * The public half of the key licenses are signed with. Null until one is
 * generated (`bun scripts/license-keygen.ts`) and pasted here; while it is
 * null no key verifies, so every project runs on the free tier.
 */
export const LICENSE_PUBLIC_KEY: string | null = null;

// Every key starts with this, so a pasted string is recognizable as one and a
// future format can be told apart from this one.
const KEY_PREFIX = 'dispatch1';

/** What a verified key grants. */
export interface License {
  /** Who bought it, as the key names them. */
  org: string;
  /** How many people it covers, the operator included. */
  seats: number;
  issuedAt: string;
  /** When it stops covering anyone, or null for a perpetual key. */
  expiresAt: string | null;
}

/** Where a project's seat count comes from right now. */
export type LicenseState =
  | { kind: 'free'; seats: number }
  | { kind: 'licensed'; seats: number; license: License }
  | { kind: 'expired'; seats: number; license: License }
  | { kind: 'invalid'; seats: number; reason: string };

function base64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}

/** The payload, if it has the shape a license needs; null otherwise. */
function parsePayload(bytes: Buffer): License | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.org !== 'string' || o.org.trim() === '') return null;
  if (
    typeof o.seats !== 'number' ||
    !Number.isInteger(o.seats) ||
    o.seats < 1
  ) {
    return null;
  }
  if (typeof o.issuedAt !== 'string' || Number.isNaN(Date.parse(o.issuedAt)))
    return null;
  if (
    o.expiresAt !== null &&
    (typeof o.expiresAt !== 'string' || Number.isNaN(Date.parse(o.expiresAt)))
  ) {
    return null;
  }
  return {
    org: o.org,
    seats: o.seats,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
  };
}

/**
 * Reads a license key: `dispatch1.<payload>.<signature>`, both parts
 * base64url, the signature an Ed25519 signature over `dispatch1.<payload>`.
 * Returns the state it puts a project in — never throws, since a bad key
 * must leave the daemon running on the free tier.
 */
export function readLicenseKey(
  key: string,
  publicKey: string | null,
  now: Date
): LicenseState {
  const invalid = (reason: string): LicenseState => ({
    kind: 'invalid',
    seats: FREE_SEATS,
    reason,
  });
  if (publicKey === null) {
    return invalid('this build of Dispatch has no license public key');
  }
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return invalid('not a Dispatch license key');
  }
  const payload = base64url(parts[1]);
  const signature = base64url(parts[2]);
  if (payload === null || signature === null) {
    return invalid('not a Dispatch license key');
  }
  let signed: boolean;
  try {
    signed = verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      createPublicKey(publicKey),
      signature
    );
  } catch {
    signed = false;
  }
  if (!signed) return invalid('the signature does not match');
  const license = parsePayload(payload);
  if (license === null) return invalid('the key is signed but unreadable');
  if (
    license.expiresAt !== null &&
    now.getTime() >= Date.parse(license.expiresAt)
  ) {
    return { kind: 'expired', seats: FREE_SEATS, license };
  }
  // A key never covers fewer people than having no key would.
  return {
    kind: 'licensed',
    seats: Math.max(license.seats, FREE_SEATS),
    license,
  };
}

/**
 * Signs a license with the private key — what `scripts/license-issue.ts`
 * runs for a customer, and what tests use with a key pair of their own. Of no
 * use without the private key, which never leaves whoever issues licenses.
 */
export function signLicense(license: License, privateKeyPem: string): string {
  const payload = Buffer.from(JSON.stringify(license), 'utf8').toString(
    'base64url'
  );
  const signed = `${KEY_PREFIX}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(signed, 'utf8'),
    createPrivateKey(privateKeyPem)
  ).toString('base64url');
  return `${signed}.${signature}`;
}
