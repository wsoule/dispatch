import type { JsonValue } from '@dispatch/protocol';
import { canonicalize } from '@dispatch/protocol/federation';
import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint, publicJwkOf } from '../sig/keys.js';
import { parseReach } from './code.js';
import type { Reach } from './reach.js';

// Upgrading a bearer pair to signatures (P5): the proof a side sends over its
// existing bearer channel. With no code there is no MAC; the bearer stands in
// for it, and the other side's owner approves the key through a gate.

const TAG = 'dispatch-a2a-upgrade-v1';
const ID = /^[A-Za-z0-9_-]{22}$/;
const NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,100}$/u;
// A proof is fresh for ten minutes either way.
const FRESH_MS = 10 * 60_000;

export interface UpgradeProof {
  v: 1;
  id: string;
  reach: Reach;
  name: string;
  jwk: Record<string, string>;
  at: string;
  // The origin it is sent to, and the client credential it rides on: a proof
  // replayed to another agent, or over another client's bearer, fails.
  audience: string;
  client: string;
  sig: string;
}

/** A proof's `client` binding of the bearer it is sent with. */
export function upgradeClientBinding(bearer: string): string {
  return createHash('sha256')
    .update(`dispatch-a2a-upgrade-client\n${bearer}`)
    .digest('base64url');
}

function proofBytes(p: Omit<UpgradeProof, 'sig'>): Buffer {
  return Buffer.from(`${TAG}\n${canonicalize(p as unknown as JsonValue)}`);
}

export function makeUpgradeProof(i: {
  reach: Reach;
  name: string;
  privateKey: KeyObject;
  jwk: Record<string, string>;
  now: Date;
  audience: string;
  client: string;
}): UpgradeProof {
  const unsigned = {
    v: 1 as const,
    id: randomBytes(16).toString('base64url'),
    reach: i.reach,
    name: i.name,
    jwk: publicJwkOf(i.jwk),
    at: i.now.toISOString(),
    audience: i.audience,
    client: i.client,
  };
  const sig = sign('sha256', proofBytes(unsigned), {
    key: i.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { ...unsigned, sig };
}

export type UpgradeCheck =
  | { ok: true; proof: UpgradeProof; thumbprint: string }
  | { ok: false; reason: string };

/**
 * An upgrade proof signed by the key it carries, made within ten minutes,
 * for this agent's origin and the bearer it arrived with.
 */
export function checkUpgradeProof(
  raw: unknown,
  now: Date,
  expect: { audience: string; client: string }
): UpgradeCheck {
  const bad = (reason: string): UpgradeCheck => ({ ok: false, reason });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return bad('not an upgrade proof');
  const r = raw as Record<string, unknown>;
  const reach = parseReach(r.reach);
  if (
    r.v !== 1 ||
    typeof r.id !== 'string' ||
    !ID.test(r.id) ||
    typeof r.name !== 'string' ||
    !NAME.test(r.name) ||
    typeof r.at !== 'string' ||
    typeof r.sig !== 'string' ||
    reach === null
  )
    return bad('not an upgrade proof');
  if (r.audience !== expect.audience || r.client !== expect.client)
    return bad('the proof is for another agent or client');
  const at = Date.parse(r.at);
  if (Number.isNaN(at) || Math.abs(now.getTime() - at) > FRESH_MS)
    return bad('the proof is stale');
  let jwk: Record<string, string>;
  try {
    jwk = publicJwkOf(
      typeof r.jwk === 'object' && r.jwk !== null
        ? (r.jwk as Record<string, string>)
        : {}
    );
  } catch {
    return bad('its key is not a P-256 public key');
  }
  const thumbprint = ecThumbprint(jwk);
  if (thumbprint === null) return bad('its key is not a P-256 public key');
  const unsigned = {
    v: 1 as const,
    id: r.id,
    reach,
    name: r.name,
    jwk,
    at: r.at,
    audience: expect.audience,
    client: expect.client,
  };
  let verified = false;
  try {
    verified = verify(
      'sha256',
      proofBytes(unsigned),
      {
        key: createPublicKey({ key: jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(r.sig, 'base64url')
    );
  } catch {
    verified = false;
  }
  if (!verified) return bad('it is not signed by the key it carries');
  return { ok: true, proof: { ...unsigned, sig: r.sig }, thumbprint };
}
