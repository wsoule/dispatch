import type { A2ALinkKeys } from '@dispatch/core';
import { CredentialsUnreadableError, ensureA2ALinkKeys } from '@dispatch/core';
import type { JsonValue } from '@dispatch/protocol';
import {
  canonicalize,
  generateReplicaKeys,
} from '@dispatch/protocol/federation';
import { createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { ecThumbprint } from '../sig/keys.js';

// Teammate links (P5 piece 4) sign and seal with federation's Ed25519 and
// X25519 keys. The card key binds them, so a peer that pinned the card key at
// pairing knows which link keys are this agent's.

export const LINKKEYS_TAG = 'dispatch-a2a-linkkeys-v1';

export interface LinkKeysBinding {
  v: 1;
  cardKid: string;
  signPub: string;
  sealPub: string;
  at: string;
  sig: string;
}

function bindingBytes(b: Omit<LinkKeysBinding, 'sig'>): Buffer {
  return Buffer.from(
    `${LINKKEYS_TAG}\n${canonicalize(b as unknown as JsonValue)}`
  );
}

/** The card key's statement that `link`'s public keys are this agent's. */
export function linkKeysBinding(i: {
  card: { keyid: string; privateKey: KeyObject };
  link: Pick<A2ALinkKeys, 'signPub' | 'sealPub'>;
  at: Date;
}): LinkKeysBinding {
  const unsigned = {
    v: 1 as const,
    cardKid: i.card.keyid,
    signPub: i.link.signPub,
    sealPub: i.link.sealPub,
    at: i.at.toISOString(),
  };
  const sig = sign('sha256', bindingBytes(unsigned), {
    key: i.card.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { ...unsigned, sig };
}

/** A binding the given card key made; never throws. */
export function checkLinkKeysBinding(
  raw: unknown,
  cardJwk: Record<string, string>
): { ok: true; signPub: string; sealPub: string } | { ok: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false };
  const r = raw as Record<string, unknown>;
  if (
    r.v !== 1 ||
    typeof r.cardKid !== 'string' ||
    typeof r.signPub !== 'string' ||
    typeof r.sealPub !== 'string' ||
    typeof r.at !== 'string' ||
    typeof r.sig !== 'string' ||
    r.cardKid !== ecThumbprint(cardJwk)
  )
    return { ok: false };
  const unsigned = {
    v: 1 as const,
    cardKid: r.cardKid,
    signPub: r.signPub,
    sealPub: r.sealPub,
    at: r.at,
  };
  try {
    const good = verify(
      'sha256',
      bindingBytes(unsigned),
      {
        key: createPublicKey({ key: cardJwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(r.sig, 'base64url')
    );
    return good
      ? { ok: true, signPub: r.signPub, sealPub: r.sealPub }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * This project's link keys, made once (only when the slot is absent). A
 * malformed slot or an unparseable credentials file leaves links off: null,
 * with a warning naming the problem but never the keys.
 */
export async function loadOrCreateLinkKeys(
  rootDir: string
): Promise<A2ALinkKeys | null> {
  try {
    const read = await ensureA2ALinkKeys(rootDir, generateReplicaKeys);
    if (read.status === 'ok') return read.keys;
    console.warn(
      'a2a: the stored teammate-link keys are malformed; links stay off until the slot is fixed'
    );
    return null;
  } catch (err) {
    if (!(err instanceof CredentialsUnreadableError)) throw err;
    console.warn(
      'a2a: the credentials file cannot be parsed; teammate links stay off'
    );
    return null;
  }
}
