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
  // One uniform refusal, so a client learns nothing of which check failed.
  if (!result.ok) {
    console.warn(`a2a: signed request refused (${result.reason})`);
    return REFUSED;
  }
  const client = d.store.clientByThumbprint(result.keyid);
  if (client === null) return REFUSED;
  return authenticateSignedAgent(
    d.messages.getAgent(client.address),
    client.auth ?? null
  );
}

// Whether a caller that signed in is still allowed: its row still signs and
// its agent is still approved.
export function revalidateSigned(d: SignedDeps, caller: Caller): boolean {
  const client = d.store.getClient(caller.address);
  return authenticateSignedAgent(
    d.messages.getAgent(caller.address),
    client?.auth ?? null
  ).ok;
}
