import {
  ecThumbprint,
  makeKeyChange,
  publicJwkOf,
  signedFetch,
} from '@dispatch/a2a';
import { readA2ANextSigningKey, writeA2ASigningKey } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';
import { createPrivateKey, createPublicKey } from 'node:crypto';

import {
  CardSigner,
  loadOrCreateSigningKey,
  newPrivateJwk,
} from '../../src/a2a/signing.js';
import { waitFor } from '../messaging/harness.js';
import { rawFetch } from '../testAuth.js';
import type { Daemon } from './pairHarness.js';
import {
  agentStatus,
  clientOf,
  noticesOf,
  ownerOf,
  pairingState,
  useDaemons,
} from './pairHarness.js';

const { daemon, paired, restart } = useDaemons();

interface Rotated {
  fingerprint: string;
  told: string[];
  untold: string[];
  mustRepair: string[];
}

async function rotate(a: Daemon, compromised = false): Promise<Rotated> {
  const res = await a.call('/api/a2a/keys/rotate', {
    body: compromised ? { compromised: true } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Rotated;
}

const kidOf = (root: string) => loadOrCreateSigningKey(root).kid;

// Sends `body` to a2a:<to> from d's owner and waits for its outbound row.
async function sendAndWait(d: Daemon, to: string, body: string) {
  const { message } = await d.handle.messaging.engine.send(
    { to: [`a2a:${to}`], kind: 'message', body },
    { address: await ownerOf(d), canDecide: true }
  );
  await waitFor(
    () => d.handle.a2a.store!.getOutbound(message.id, to)?.state === 'done',
    20_000
  );
}

describe('a planned key rotation', () => {
  it('keeps the pairing: the peer re-pins and asks still verify both ways', async () => {
    const a = await daemon('a2a-keys-a-');
    const b = await daemon('a2a-keys-b-');
    await paired(a, b);
    const old = kidOf(a.root);
    const bNotices = await noticesOf(b);
    const out = await rotate(a);
    expect(out).toMatchObject({ told: ['bob'], untold: [], mustRepair: [] });
    const next = readA2ANextSigningKey(a.root);
    if (next.status !== 'ok') throw new Error('no next key');
    const newKid = ecThumbprint(publicJwkOf(next.next.jwk))!;
    expect(newKid).not.toBe(old);
    expect(b.handle.a2a.store!.getPeer('alice')?.keyThumbprint).toBe(newKid);
    expect(clientOf(b, 'a2a.alice').keyThumbprint).toBe(newKid);
    await waitFor(
      () => bNotices().some((n) => n.includes('a2a:alice rotated its key')),
      5000
    );
    await sendAndWait(b, 'alice', 'From Bob, after the rotation.');
    await sendAndWait(a, 'bob', 'From Alice, after the rotation.');
    // Only the operator rotates.
    const lead = a.handle.team.teammates.issue('ada', 'decide');
    expect(
      (await a.call('/api/a2a/keys/rotate', { body: {}, token: lead })).status
    ).toBe(403);
    // A second rotation waits for the overlap to end.
    expect((await a.call('/api/a2a/keys/rotate', { body: {} })).status).toBe(
      409
    );
  });

  it('refuses an older key-change statement once a newer one applied', async () => {
    const a = await daemon('a2a-keys-a-');
    const b = await daemon('a2a-keys-b-');
    await paired(a, b);
    await rotate(a);
    const read = readA2ANextSigningKey(a.root);
    if (read.status !== 'ok') throw new Error('no next key');
    const k2 = read.next.jwk;
    const k2Public = publicJwkOf(k2);
    const k2Kid = ecThumbprint(k2Public)!;
    const applied = Date.parse(read.next.at);
    const bKey = new CardSigner(loadOrCreateSigningKey(b.root)).publicJwk();
    const send = signedFetch(rawFetch, {
      keyid: k2Kid,
      privateKey: createPrivateKey({ key: k2, format: 'jwk' }),
      peerKey: createPublicKey({ key: bKey, format: 'jwk' }),
    });
    const post = (at: number) => {
      const kx = publicJwkOf(newPrivateJwk());
      return send(`${b.listener}/a2a/v1/dispatch/key-change`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: JSON.stringify(
          makeKeyChange({
            oldJwk: k2Public,
            oldKey: createPrivateKey({ key: k2, format: 'jwk' }),
            newJwk: kx,
            at: new Date(at),
          })
        ),
      });
    };
    const older = await post(applied - 60_000);
    expect(older.status).toBe(409);
    expect(b.handle.a2a.store!.getPeer('alice')?.keyThumbprint).toBe(k2Kid);
    const newer = await post(applied + 60_000);
    expect(newer.status).toBe(200);
    expect(b.handle.a2a.store!.getPeer('alice')?.keyThumbprint).not.toBe(k2Kid);
  });

  it('a peer that missed the push fetches the statement on its next key-unknown reply', async () => {
    const a = await daemon('a2a-keys-a-');
    const b = await daemon('a2a-keys-b-');
    await paired(a, b);
    const bListener = b.listener.split(':').pop();
    expect(
      (
        await b.call('/api/a2a/listener', {
          method: 'PUT',
          body: { enabled: false },
        })
      ).status
    ).toBe(200);
    const out = await rotate(a);
    expect(out).toMatchObject({ told: [], untold: ['bob'] });
    const before = b.handle.a2a.store!.getPeer('alice')?.keyThumbprint;
    await sendAndWait(b, 'alice', 'From Bob, who missed it.');
    expect(b.handle.a2a.store!.getPeer('alice')?.keyThumbprint).not.toBe(
      before
    );
    expect(bListener).toBeDefined();
  }, 30_000);
});

describe('an unplanned key loss', () => {
  it('makes the peer refuse the new key and tell its owner', async () => {
    const a = await daemon('a2a-keys-a-');
    const b = await daemon('a2a-keys-b-');
    await paired(a, b);
    const pinned = b.handle.a2a.store!.getPeer('alice')?.keyThumbprint;
    // The credentials file was rebuilt: a new key, with no statement.
    writeA2ASigningKey(a.root, newPrivateJwk());
    await restart(a);
    const bNotices = await noticesOf(b);
    await b.handle.messaging.engine.send(
      { to: ['a2a:alice'], kind: 'message', body: 'Still you?' },
      { address: await ownerOf(b), canDecide: true }
    );
    await waitFor(
      () =>
        bNotices().some((n) =>
          n.includes('presents a new key with no statement')
        ),
      20_000
    );
    expect(b.handle.a2a.store!.getPeer('alice')?.keyThumbprint).toBe(pinned);
  });
});

describe('a compromised key', () => {
  it('sends a revocation the peer honours by disabling the pairing', async () => {
    const a = await daemon('a2a-keys-a-');
    const b = await daemon('a2a-keys-b-');
    await paired(a, b);
    const old = kidOf(a.root);
    const bNotices = await noticesOf(b);
    const out = await rotate(a, true);
    expect(out).toMatchObject({ told: ['bob'], mustRepair: ['bob'] });
    // No overlap: the old key is gone at once.
    expect(kidOf(a.root)).not.toBe(old);
    expect(readA2ANextSigningKey(a.root).status).toBe('absent');
    expect(b.handle.a2a.store!.getPeer('alice')?.status).toBe('disabled');
    expect(agentStatus(b, 'a2a.alice')).toBe('revoked');
    expect(pairingState(b)).toBe('unpaired');
    await waitFor(
      () => bNotices().some((n) => n.includes('a2a:alice revoked its key')),
      5000
    );
    // This side drops its records of the pairing too.
    expect(a.handle.a2a.store!.getPeer('bob')?.status).toBe('disabled');
    expect(pairingState(a)).toBe('unpaired');
  });
});
