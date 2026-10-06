import type { A2ALinkKeys } from '@dispatch-foo/core';
import {
  CredentialsUnreadableError,
  ensureA2ALinkKeys,
} from '@dispatch-foo/core';
import type { JsonValue } from '@dispatch-foo/protocol';
import {
  canonicalize,
  canSealTo,
  generateReplicaKeys,
  signText,
  verifyText,
} from '@dispatch-foo/protocol/federation';
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
  // The card key's signature, and the link sign key's over the same bytes:
  // proof the binder holds the link key it names (relay re-review N2).
  sig: string;
  linkSig: string;
}

function bindingBytes(b: Omit<LinkKeysBinding, 'sig' | 'linkSig'>): Buffer {
  return Buffer.from(
    `${LINKKEYS_TAG}\n${canonicalize(b as unknown as JsonValue)}`
  );
}

// A raw 32-byte public key in base64url.
function rawKey32(v: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').length === 32
  );
}

/** The card key's statement that `link`'s public keys are this agent's. */
export function linkKeysBinding(i: {
  card: { keyid: string; privateKey: KeyObject };
  link: Pick<A2ALinkKeys, 'signPriv' | 'signPub' | 'sealPub'>;
  at: Date;
}): LinkKeysBinding {
  const unsigned = {
    v: 1 as const,
    cardKid: i.card.keyid,
    signPub: i.link.signPub,
    sealPub: i.link.sealPub,
    at: i.at.toISOString(),
  };
  const bytes = bindingBytes(unsigned);
  const sig = sign('sha256', bytes, {
    key: i.card.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const linkSig = signText(i.link.signPriv, bytes.toString('utf8'));
  return { ...unsigned, sig, linkSig };
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
    typeof r.linkSig !== 'string' ||
    r.cardKid !== ecThumbprint(cardJwk) ||
    !rawKey32(r.signPub) ||
    !canSealTo(r.sealPub)
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
    if (!good) return { ok: false };
    // The link key itself signed the same bytes (verifyText refuses small-order keys).
    if (
      !verifyText(r.signPub, bindingBytes(unsigned).toString('utf8'), r.linkSig)
    )
      return { ok: false };
    return { ok: true, signPub: r.signPub, sealPub: r.sealPub };
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
