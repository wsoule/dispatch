import {
  a2aFingerprint,
  ecThumbprint,
  makeUpgradeProof,
  publicJwkOf,
  SIG_EXTENSION_URI,
  signedFetch,
  upgradeClientBinding,
} from '@dispatch/a2a';
import { readPeerCredential } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CardSigner, loadOrCreateSigningKey } from '../../src/a2a/signing.js';
import { waitFor } from '../messaging/harness.js';
import { rawFetch } from '../testAuth.js';
import type { Daemon } from './pairHarness.js';
import { clientOf, ownerOf, useDaemons } from './pairHarness.js';

const { daemon } = useDaemons();

// Registers an approved A2A client named `name` on `d`; its bearer token.
async function client(d: Daemon, name: string): Promise<string> {
  const res = await d.call('/api/a2a/clients', {
    body: { name, approve: true },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

// The P3 arrangement: A reaches B as a2a:bob with B's token for it, and B
// reaches A as a2a:alice with A's token for it.
async function bearerPair(a: Daemon, b: Daemon) {
  const onB = await client(b, 'alice');
  const onA = await client(a, 'bob');
  const peer = (d: Daemon, alias: string, of: Daemon, token: string) =>
    d.call('/api/a2a/peers', {
      body: {
        alias,
        cardUrl: `${of.listener}/.well-known/agent-card.json`,
        token,
      },
    });
  expect((await peer(a, 'bob', b, onB)).status).toBe(201);
  expect((await peer(b, 'alice', a, onA)).status).toBe(201);
  return { onA, onB };
}

const fingerprintOf = (d: Daemon) =>
  a2aFingerprint(loadOrCreateSigningKey(d.root).kid);

// The open upgrade question on `d`, if any (system-raised, to its owner).
function upgradeGate(d: Daemon) {
  return d.handle.messaging.engine
    .openBlocking()
    .find((q) => q.body.includes('wants to switch to signed requests'));
}

const send = (d: Daemon, token: string, extensions?: string) =>
  rawFetch(`${d.listener}/a2a/v1/message:send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      authorization: `Bearer ${token}`,
      ...(extensions === undefined ? {} : { 'a2a-extensions': extensions }),
    },
    body: JSON.stringify({
      message: {
        messageId: `m-${Math.random().toString(36).slice(2)}`,
        role: 'ROLE_USER',
        parts: [{ text: 'Hello.' }],
      },
      configuration: { returnImmediately: true },
    }),
  });

describe('upgrading a bearer pair to signatures', () => {
  it('opens a gate on the other side; on approval both sides sign and the bearers are gone', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    const { onB } = await bearerPair(a, b);
    const res = await a.call('/api/a2a/peers/bob/upgrade', {
      body: { confirmFingerprint: fingerprintOf(b) },
    });
    expect(res.status).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    const gate = upgradeGate(b)!;
    expect(gate.body).toContain(fingerprintOf(a));
    await b.handle.messaging.engine.reply(
      gate.id,
      { body: '', choice: 'approve' },
      { address: await ownerOf(b), canDecide: true }
    );
    await waitFor(
      () =>
        a.handle.a2a.store!.getPeer('bob')?.auth === 'signature' &&
        b.handle.a2a.store!.getPeer('alice')?.auth === 'signature',
      15_000
    );
    expect(clientOf(a, 'a2a.bob').auth).toBe('signature');
    expect(clientOf(b, 'a2a.alice').auth).toBe('signature');
    expect(a.handle.a2a.store!.getPeer('bob')?.keyThumbprint).toBe(
      loadOrCreateSigningKey(b.root).kid
    );
    expect(clientOf(b, 'a2a.alice').keyThumbprint).toBe(
      loadOrCreateSigningKey(a.root).kid
    );
    // The bearers are gone on both sides.
    expect((await send(b, onB)).status).toBe(401);
    expect(readPeerCredential(a.root, 'bob')).toBeNull();
    expect(readPeerCredential(b.root, 'alice')).toBeNull();
    // And mail still flows, signed.
    const { message } = await a.handle.messaging.engine.send(
      { to: ['a2a:bob'], kind: 'message', body: 'Signed now.' },
      { address: await ownerOf(a), canDecide: true }
    );
    await waitFor(
      () =>
        a.handle.a2a.store!.getOutbound(message.id, 'bob')?.state === 'done',
      15_000
    );
  }, 40_000);

  it('a declined gate changes nothing', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    const { onB } = await bearerPair(a, b);
    expect(
      (
        await a.call('/api/a2a/peers/bob/upgrade', {
          body: { confirmFingerprint: fingerprintOf(b) },
        })
      ).status
    ).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    const gate = upgradeGate(b)!;
    await b.handle.messaging.engine.reply(
      gate.id,
      { body: '', choice: 'decline' },
      { address: await ownerOf(b), canDecide: true }
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(clientOf(b, 'a2a.alice').auth ?? 'bearer').toBe('bearer');
    expect(a.handle.a2a.store!.getPeer('bob')?.auth ?? 'bearer').toBe('bearer');
    expect((await send(b, onB)).status).toBe(200);
  }, 30_000);

  it('a wrong fingerprint is 400 and nothing is sent', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    const res = await a.call('/api/a2a/peers/bob/upgrade', {
      body: { confirmFingerprint: fingerprintOf(a) },
    });
    expect(res.status).toBe(400);
    expect(b.handle.a2a.store!.pairings()).toEqual([]);
    expect(upgradeGate(b)).toBeUndefined();
  });

  it('a card without the signature extension is 400 "this peer cannot sign"', async () => {
    const a = await daemon('a2a-up-a-');
    const plain = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const url = new URL(req.url);
        return Response.json({
          name: 'Plain agent',
          description: 'Not Dispatch.',
          version: '1',
          capabilities: { streaming: false },
          skills: [],
          supportedInterfaces: [
            {
              url: `${url.origin}/a2a/v1`,
              protocolBinding: 'HTTP+JSON',
              protocolVersion: '1.0',
            },
          ],
          securitySchemes: {
            bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
          },
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        });
      },
    });
    try {
      const added = await a.call('/api/a2a/peers', {
        body: {
          alias: 'plain',
          cardUrl: `http://127.0.0.1:${plain.port}/.well-known/agent-card.json`,
          token: 't',
        },
      });
      expect(added.status).toBe(201);
      const res = await a.call('/api/a2a/peers/plain/upgrade', {
        body: { confirmFingerprint: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('this peer cannot sign');
    } finally {
      await plain.stop(true);
    }
  });

  it('with requireSignedDispatchPeers, a client that once presented the extension loses its bearer', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    const { onB } = await bearerPair(a, b);
    const plainToken = await client(b, 'carol');
    writeFileSync(
      join(b.root, '.dispatch', 'config.yml'),
      'a2a:\n  requireSignedDispatchPeers: true\n'
    );
    expect((await send(b, onB)).status).toBe(200);
    expect((await send(b, onB, SIG_EXTENSION_URI)).status).toBe(401);
    // Remembered: later bearers fail without the header too.
    expect((await send(b, onB)).status).toBe(401);
    // A client that never presented it keeps its bearer.
    expect((await send(b, plainToken)).status).toBe(200);
  });

  it('only a decide-tier human may upgrade, and not the agent token', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    const member = a.handle.team.teammates.issue('bo', 'request');
    const body = { confirmFingerprint: fingerprintOf(b) };
    expect(
      (await a.call('/api/a2a/peers/bob/upgrade', { body, token: member }))
        .status
    ).toBe(403);
    expect(
      (
        await a.call('/api/a2a/peers/bob/upgrade', {
          body,
          token: a.handle.tokens.agentToken,
        })
      ).status
    ).toBe(403);
  });
});

describe('batch 4 review C1: an upgrade is approved only by the other side’s owner', () => {
  // The victim's bearer and a key of the attacker's choosing.
  async function selfRequest(b: Daemon, bearer: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicJwkOf(
      publicKey.export({ format: 'jwk' }) as Record<string, string>
    );
    const proof = makeUpgradeProof({
      reach: {
        kind: 'url',
        card: 'https://mallory.example.com/.well-known/agent-card.json',
      },
      name: 'Mallory',
      privateKey,
      jwk,
      now: new Date(),
      audience: new URL(b.listener).origin,
      client: upgradeClientBinding(bearer),
    });
    const res = await rawFetch(`${b.listener}/a2a/v1/dispatch/upgrade`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ type: 'request', proof }),
    });
    return { res, proof, privateKey, kid: ecThumbprint(jwk)! };
  }

  it('a requester posting approved for its own request gets 404, and nothing changes', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    const { onB } = await bearerPair(a, b);
    const { res, proof, privateKey, kid } = await selfRequest(b, onB);
    expect(res.status).toBe(202);
    const bKey = new CardSigner(loadOrCreateSigningKey(b.root)).publicJwk();
    const signed = signedFetch(rawFetch, {
      keyid: kid,
      privateKey,
      peerKey: createPublicKey({ key: bKey, format: 'jwk' }),
    });
    const approved = await signed(`${b.listener}/a2a/v1/dispatch/upgrade`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: `Bearer ${onB}`,
      },
      body: JSON.stringify({ type: 'approved', id: proof.id }),
    });
    expect(approved.status).toBe(404);
    expect(clientOf(b, 'a2a.alice').auth ?? 'bearer').toBe('bearer');
    expect((await send(b, onB)).status).toBe(200);
    expect(upgradeGate(b)).toBeDefined();
  });

  it('ignores an answer from someone who cannot decide, or from another replica', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    expect(
      (
        await a.call('/api/a2a/peers/bob/upgrade', {
          body: { confirmFingerprint: fingerprintOf(b) },
        })
      ).status
    ).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    const gate = upgradeGate(b)!;
    const base = {
      id: 'm-forged',
      thread: gate.thread,
      replyTo: gate.id,
      to: gate.to,
      kind: 'answer' as const,
      body: '',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none' as const,
      createdAt: new Date().toISOString(),
      choice: 'approve',
    };
    const owner = await ownerOf(b);
    b.handle.a2a.upgrades!.answered({ ...base, from: 'human:mallory' });
    b.handle.a2a.upgrades!.answered({
      ...base,
      from: owner,
      origin: 'replica-x',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(clientOf(b, 'a2a.alice').auth ?? 'bearer').toBe('bearer');
    expect(a.handle.a2a.store!.getPeer('bob')?.auth ?? 'bearer').toBe('bearer');
  });
});

describe('batch 4 review C1: the approval comes from the paired client', () => {
  it('with the client named at start, an approval over another client’s bearer is refused', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    // The upgrade names a client B does not use: B's approval cannot match it.
    await client(a, 'someone-else');
    const res = await a.call('/api/a2a/peers/bob/upgrade', {
      body: {
        confirmFingerprint: fingerprintOf(b),
        client: 'a2a.someone-else',
      },
    });
    expect(res.status).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    await b.handle.messaging.engine.reply(
      upgradeGate(b)!.id,
      { body: '', choice: 'approve' },
      { address: await ownerOf(b), canDecide: true }
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(a.handle.a2a.store!.getPeer('bob')?.auth ?? 'bearer').toBe('bearer');
    expect(clientOf(a, 'a2a.bob').auth ?? 'bearer').toBe('bearer');
    expect(clientOf(a, 'a2a.someone-else').auth ?? 'bearer').toBe('bearer');
  }, 30_000);

  it('with the right client named, the upgrade completes', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    const res = await a.call('/api/a2a/peers/bob/upgrade', {
      body: { confirmFingerprint: fingerprintOf(b), client: 'a2a.bob' },
    });
    expect(res.status).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    await b.handle.messaging.engine.reply(
      upgradeGate(b)!.id,
      { body: '', choice: 'approve' },
      { address: await ownerOf(b), canDecide: true }
    );
    await waitFor(() => clientOf(a, 'a2a.bob').auth === 'signature', 15_000);
  }, 30_000);
});

describe('batch 4 review N3: the upgrade proof is bound', () => {
  it('refuses a proof made for another agent, or carried over another bearer', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    const { onB } = await bearerPair(a, b);
    const other = await client(b, 'carol');
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicJwkOf(
      publicKey.export({ format: 'jwk' }) as Record<string, string>
    );
    const post = (bearer: string, audience: string, boundTo: string) =>
      rawFetch(`${b.listener}/a2a/v1/dispatch/upgrade`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          type: 'request',
          proof: makeUpgradeProof({
            reach: {
              kind: 'url',
              card: 'https://x.example.com/.well-known/agent-card.json',
            },
            name: 'X',
            privateKey,
            jwk,
            now: new Date(),
            audience,
            client: upgradeClientBinding(boundTo),
          }),
        }),
      });
    const origin = new URL(b.listener).origin;
    expect((await post(onB, 'https://elsewhere.example.com', onB)).status).toBe(
      400
    );
    expect((await post(other, origin, onB)).status).toBe(400);
    expect(upgradeGate(b)).toBeUndefined();
  });
});

describe('batch 4 review N4: approvals are idempotent, and a refused pin changes nothing', () => {
  async function approveFlow(a: Daemon, b: Daemon) {
    expect(
      (
        await a.call('/api/a2a/peers/bob/upgrade', {
          body: { confirmFingerprint: fingerprintOf(b) },
        })
      ).status
    ).toBe(202);
    await waitFor(() => upgradeGate(b) !== undefined, 10_000);
    const id = a.handle.a2a
      .store!.pairings()
      .find((p) => p.role === 'upgrade-out')!.id;
    await b.handle.messaging.engine.reply(
      upgradeGate(b)!.id,
      { body: '', choice: 'approve' },
      { address: await ownerOf(b), canDecide: true }
    );
    return id;
  }

  it('a repeated approval for the same id and key answers 200 again', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    const id = await approveFlow(a, b);
    await waitFor(() => clientOf(b, 'a2a.alice').auth === 'signature', 15_000);
    const bKey = loadOrCreateSigningKey(b.root);
    const aKey = new CardSigner(loadOrCreateSigningKey(a.root)).publicJwk();
    const signed = signedFetch(rawFetch, {
      keyid: bKey.kid,
      privateKey: createPrivateKey({ key: bKey.privateJwk, format: 'jwk' }),
      peerKey: createPublicKey({ key: aKey, format: 'jwk' }),
    });
    const again = await signed(`${a.listener}/a2a/v1/dispatch/upgrade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ type: 'approved', id }),
    });
    expect(again.status).toBe(200);
  }, 30_000);

  it('a pin the store refuses rolls the whole switch back', async () => {
    const a = await daemon('a2a-up-a-');
    const b = await daemon('a2a-up-b-');
    await bearerPair(a, b);
    // Another peer row on A already pins B's key.
    const bKid = loadOrCreateSigningKey(b.root).kid;
    const bJwk = new CardSigner(loadOrCreateSigningKey(b.root)).publicJwk();
    const store = a.handle.a2a.store!;
    store.putPeer({ ...store.getPeer('bob')!, alias: 'decoy' });
    expect(
      store.setPeerKey('decoy', {
        thumbprint: bKid,
        jwk: bJwk,
        auth: 'signature',
        pairedId: null,
      })
    ).toBe(true);
    await approveFlow(a, b);
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.getPeer('bob')?.auth ?? 'bearer').toBe('bearer');
    expect(clientOf(a, 'a2a.bob').auth ?? 'bearer').toBe('bearer');
    expect(store.pairings().find((p) => p.role === 'upgrade-out')?.state).toBe(
      'offered'
    );
  }, 30_000);
});
