import { verifyRequest } from '@dispatch/a2a';
import type {
  A2AStore,
  AuthResult,
  Caller,
  ReceivedRequest,
} from '@dispatch/a2a';
import type { AgentRecord } from '@dispatch/protocol';
import { MAX_CLOCK_LEAD_MS } from '@dispatch/protocol/federation';
import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { authenticateSignedAgent } from './auth.js';

// Live nonces one key may hold before its requests answer 429.
const NONCE_CAP = 10_000;
const BUSY_RETRY_SEC = 30;

const REFUSED: AuthResult = {
  ok: false,
  status: 401,
  reason: 'AUTH_INVALID_TOKEN',
  message: 'unknown token',
};

export interface SignedDeps {
  store: A2AStore;
  messages: { getAgent(address: string): AgentRecord | null };
  now?: () => Date;
}

// The pinned public key of the one client row that signs with `keyid`.
function pinnedKey(store: A2AStore, keyid: string): KeyObject | null {
  const client = store.clientByThumbprint(keyid);
  if (client?.auth !== 'signature' || client.keyJwk == null) return null;
  try {
    return createPublicKey({ key: client.keyJwk, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * A request a Dispatch peer signed, verified against `origin` (the configured
 * URL the client was told to call). null when it carries no Dispatch
 * signature, so the bearer path decides. Refusals log their class only.
 */
export function verifySignedClient(
  d: SignedDeps,
  req: ReceivedRequest,
  origin: string
): AuthResult | null {
  const now = d.now?.() ?? new Date();
  const result = verifyRequest(req, {
    configuredOrigin: origin,
    keyFor: (keyid) => pinnedKey(d.store, keyid),
    now,
    guardMs: MAX_CLOCK_LEAD_MS,
    rememberNonce: (keyid, nonce, expiresAt) =>
      d.store.rememberNonce(keyid, nonce, expiresAt, NONCE_CAP, now),
  });
  if (!result.ok && result.reason === 'sig_missing') return null;
  // One uniform refusal, so a client learns nothing of which check failed;
  // a key at its nonce cap verified, so it gets a signed 429 instead.
  if (!result.ok) {
    console.warn(`a2a: signed request refused (${result.reason})`);
    const signer =
      result.reason === 'sig_busy' && result.keyid !== undefined
        ? signerOf(d.store, result.keyid)
        : null;
    return signer === null
      ? REFUSED
      : {
          ok: false,
          status: 429,
          reason: 'AUTH_BUSY',
          message: 'too many signed requests at once; retry shortly',
          retryAfterSec: BUSY_RETRY_SEC,
          verified: signer,
        };
  }
  const signer = signerOf(d.store, result.keyid);
  if (signer === null) return REFUSED;
  const client = d.store.clientByThumbprint(result.keyid);
  const auth = authenticateSignedAgent(
    d.messages.getAgent(signer.address),
    client?.auth ?? null
  );
  // The signature verified either way: a refusal is signed so the peer can trust it.
  return auth.ok
    ? { ok: true, caller: { ...auth.caller, keyid: result.keyid } }
    : { ...auth, verified: signer };
}

// The caller a verified key belongs to: the one client row that pins it.
function signerOf(store: A2AStore, keyid: string): Caller | null {
  const client = store.clientByThumbprint(keyid);
  if (client === null) return null;
  return {
    address: client.address,
    name: client.address.slice(client.address.indexOf('/') + 1),
    keyid,
  };
}

// Whether a caller that signed in is still allowed: its row still pins the
// key it signed with, still signs, and its agent is still approved.
export function revalidateSigned(d: SignedDeps, caller: Caller): boolean {
  return authenticateByKey(d, caller.address, caller.keyid).ok;
}

/** A signed caller re-checked by address and the key it proved. */
export function authenticateByKey(
  d: SignedDeps,
  address: string,
  keyid: string | undefined
): AuthResult {
  const client = d.store.getClient(address);
  if (keyid === undefined || client?.keyThumbprint !== keyid) return REFUSED;
  const auth = authenticateSignedAgent(
    d.messages.getAgent(address),
    client.auth ?? null
  );
  return auth.ok ? { ok: true, caller: { ...auth.caller, keyid } } : auth;
}
