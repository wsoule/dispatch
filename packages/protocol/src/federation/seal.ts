import { randomBytes } from 'node:crypto';

import type { JsonValue } from '../envelope.js';
import { b64u, fromB64u } from './encoding.js';
import { aeadOpen, aeadSeal, openBase, sealBase } from './hpke.js';
import { canonicalize } from './jcs.js';
import { privateKeyOf, publicOfPrivate } from './keys.js';
import { MAX_SEALED_RECIPIENTS, TAG } from './ops.js';
import type { FederatedOp, Sealed } from './ops.js';

const CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 12;

// Binds a ciphertext to its op, so it cannot be moved into another one.
export function sealedAad(replica: string, seq: number, type: string): string {
  return `${TAG.sealed}\n${replica}\n${seq}\n${type}`;
}

// Encrypts the payload once under a random content key K, and wraps K for
// each recipient with single-shot HPKE; `info` binds each wrap to its recipient.
export function sealPayload(input: {
  replica: string;
  seq: number;
  type: 'mail' | 'state';
  payload: JsonValue;
  recipients: ReadonlyMap<string, string>;
}): { to: string[]; sealed: Sealed; key: Buffer } {
  const to = [...input.recipients.keys()].sort();
  if (to.length === 0 || to.length > MAX_SEALED_RECIPIENTS)
    throw new RangeError(
      `a sealed op names 1-${MAX_SEALED_RECIPIENTS} recipients`
    );
  const key = randomBytes(CONTENT_KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = sealedAad(input.replica, input.seq, input.type);
  const ct = aeadSeal(
    key,
    nonce,
    Buffer.from(aad),
    Buffer.from(canonicalize(input.payload))
  );
  const keys: Sealed['keys'] = {};
  for (const r of to)
    keys[r] = wrapContentKey(key, aad, r, input.recipients.get(r) ?? '');
  return { to, sealed: { nonce: b64u(nonce), ct: b64u(ct), keys }, key };
}

export function wrapContentKey(
  key: Buffer,
  aad: string,
  recipient: string,
  sealPub: string
): { enc: string; ct: string } {
  const { enc, ct } = sealBase(
    fromB64u(sealPub),
    Buffer.from(`${aad}\n${recipient}`),
    key
  );
  return { enc: b64u(enc), ct: b64u(ct) };
}

// Null when the op is not sealed to `me` or any part fails to open.
export function unwrapContentKey(
  op: FederatedOp,
  me: string,
  sealPriv: string
): Buffer | null {
  const wrap = op.sealed?.keys[me];
  if (wrap === undefined) return null;
  try {
    const skR = privateKeyOf(sealPriv);
    const pkR = fromB64u(publicOfPrivate(sealPriv));
    const aad = sealedAad(op.replica, op.seq, op.type);
    return openBase(
      fromB64u(wrap.enc),
      skR,
      pkR,
      Buffer.from(`${aad}\n${me}`),
      fromB64u(wrap.ct)
    );
  } catch {
    return null;
  }
}

// Opens the payload with a content key already in hand, as a forward carries.
export function openWithKey(op: FederatedOp, key: Buffer): JsonValue | null {
  if (op.sealed === undefined) return null;
  try {
    const aad = sealedAad(op.replica, op.seq, op.type);
    const pt = aeadOpen(
      key,
      fromB64u(op.sealed.nonce),
      Buffer.from(aad),
      fromB64u(op.sealed.ct)
    );
    return JSON.parse(pt.toString('utf8')) as JsonValue;
  } catch {
    return null;
  }
}

export function openPayload(
  op: FederatedOp,
  me: string,
  sealPriv: string
): JsonValue | null {
  const key = unwrapContentKey(op, me, sealPriv);
  return key === null ? null : openWithKey(op, key);
}
