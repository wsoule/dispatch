import { describe, expect, it } from 'bun:test';

import { generateReplicaKeys } from '../../src/federation/keys.js';
import type { FederatedOp } from '../../src/federation/ops.js';
import { openPayload, sealPayload } from '../../src/federation/seal.js';

const alice = generateReplicaKeys();
const bob = generateReplicaKeys();
const cy = generateReplicaKeys();
const eve = generateReplicaKeys();
const recipients = new Map([
  ['bob-0000000b', bob.sealPub],
  ['cy-0000000c', cy.sealPub],
]);

function sealedOp(payload = { hello: 'world' }, seq = 7): FederatedOp {
  const { to, sealed } = sealPayload({
    replica: 'alice-0000000a',
    seq,
    type: 'mail',
    payload,
    recipients,
  });
  return {
    v: 2,
    replica: 'alice-0000000a',
    seq,
    prev: '0'.repeat(64),
    hlc: '1758880000000.0000.alice-0000000a',
    type: 'mail',
    to,
    bodyHash: '',
    sealed,
    sig: '',
  };
}

describe('sealing', () => {
  it('opens for every recipient and for nobody else', () => {
    const op = sealedOp();
    expect(op.to).toEqual(['bob-0000000b', 'cy-0000000c']);
    expect(openPayload(op, 'bob-0000000b', bob.sealPriv)).toEqual({
      hello: 'world',
    });
    expect(openPayload(op, 'cy-0000000c', cy.sealPriv)).toEqual({
      hello: 'world',
    });
    expect(openPayload(op, 'eve-0000000e', eve.sealPriv)).toBeNull();
    expect(openPayload(op, 'bob-0000000b', cy.sealPriv)).toBeNull();
    expect(alice.sealPub).not.toBe(bob.sealPub);
  });

  it('fails closed on tampering with any sealed field', () => {
    const op = sealedOp();
    const sealed = op.sealed;
    const wrap = sealed?.keys['bob-0000000b'];
    if (sealed === undefined || wrap === undefined) throw new Error('unsealed');
    const flip = (s: string) =>
      s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`;
    const withWrap = (w: { enc: string; ct: string }): FederatedOp => ({
      ...op,
      sealed: { ...sealed, keys: { ...sealed.keys, 'bob-0000000b': w } },
    });
    const variants: FederatedOp[] = [
      { ...op, sealed: { ...sealed, nonce: flip(sealed.nonce) } },
      { ...op, sealed: { ...sealed, ct: flip(sealed.ct) } },
      withWrap({ enc: flip(wrap.enc), ct: wrap.ct }),
      withWrap({ enc: wrap.enc, ct: flip(wrap.ct) }),
      { ...op, seq: 8 }, // a ciphertext moved into another op
      { ...op, type: 'state' },
      { ...op, replica: 'mallory-0000000f' },
    ];
    for (const v of variants)
      expect(openPayload(v, 'bob-0000000b', bob.sealPriv)).toBeNull();
  });
});
