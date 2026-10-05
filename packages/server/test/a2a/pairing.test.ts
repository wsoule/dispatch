import {
  a2aFingerprint,
  decodePairingCode,
  makeProof,
  signedFetch,
  startStandalone,
} from '@dispatch/a2a';
import { describe, expect, it } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { CardSigner, loadOrCreateSigningKey } from '../../src/a2a/signing.js';
import { waitFor } from '../messaging/harness.js';
import { rawFetch } from '../testAuth.js';
import {
  agentStatus,
  clientOf,
  noticesOf,
  ownerOf,
  pairingState,
  useDaemons,
} from './pairHarness.js';
import { freePort } from './seed.js';

const { daemon, offer, accept, stop, paired, restart } = useDaemons();

describe('pairing two daemons with one code', () => {
  it('pins both sides’ keys on signature peers and clients, and an ask round-trips signed', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const { code, fingerprint: aliceFp } = await offer(a);
    const res = await accept(b, code);
    expect(res.status).toBe(200);
    const accepted = (await res.json()) as {
      alias: string;
      sas: string;
      fingerprint: string;
    };
    expect(accepted).toMatchObject({ alias: 'alice', fingerprint: aliceFp });

    const aStore = a.handle.a2a.store!;
    const bStore = b.handle.a2a.store!;
    expect(aStore.getPeer('bob')).toMatchObject({
      auth: 'signature',
      status: 'active',
    });
    expect(bStore.getPeer('alice')).toMatchObject({
      auth: 'signature',
      status: 'active',
    });
    const aClient = aStore.clients().find((c) => c.name === 'a2a.bob');
    const bClient = bStore.clients().find((c) => c.name === 'a2a.alice');
    expect(aClient?.auth).toBe('signature');
    expect(bClient?.auth).toBe('signature');
    // Each side pins the other's key on both of its rows.
    expect(aStore.getPeer('bob')?.keyThumbprint).toBe(aClient?.keyThumbprint);
    expect(bStore.getPeer('alice')?.keyThumbprint).toBe(bClient?.keyThumbprint);
    expect(a.handle.messaging.store.getAgent(aClient!.address)?.status).toBe(
      'approved'
    );

    // Both sides show the same SAS.
    const listed = (await (await a.call('/api/a2a/pairings')).json()) as {
      pairings: {
        alias: string;
        state: string;
        sas: string | null;
        secretHash?: unknown;
      }[];
    };
    expect(listed.pairings[0]).toMatchObject({
      alias: 'bob',
      state: 'completed',
      sas: accepted.sas,
    });
    expect(JSON.stringify(listed)).not.toContain('secret');

    // B asks A, signed both ways, with no bearer anywhere.
    const { message } = await b.handle.messaging.engine.send(
      { to: ['a2a:alice'], kind: 'message', body: 'Hello from Bob.' },
      { address: 'human:test', canDecide: true }
    );
    await waitFor(
      () => bStore.getOutbound(message.id, 'alice')?.state === 'done',
      15_000
    );
  });

  it('a completed offer answers 404 to the same code, and the pair route is dark with no offer open', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const c = await daemon('a2a-pair-c-');
    const { code } = await offer(a);
    expect((await accept(b, code)).status).toBe(200);
    const again = await accept(c, code);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(c.handle.a2a.store!.getPeer('alice')).toBeNull();
    const dark = await rawFetch(`${a.listener}/a2a/v1/dispatch/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ v: 1, id: 'A'.repeat(22) }),
    });
    expect(dark.status).toBe(404);
  });

  it('a proof replayed with the same code after completion is 404, and the paired client takes no bearer', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const { code } = await offer(a);
    expect((await accept(b, code)).status).toBe(200);
    // Someone who saw the code proves a key of their own.
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const proof = makeProof({
      code: decodePairingCode(code, new Date()),
      reach: {
        kind: 'url',
        card: 'https://mallory.example.com/.well-known/agent-card.json',
      },
      name: 'Mallory',
      privateKey,
      jwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
    });
    const replay = await rawFetch(`${a.listener}/a2a/v1/dispatch/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify(proof),
    });
    expect(replay.status).toBe(404);
    expect(
      a.handle.a2a.store!.getPeer('bob')?.keyThumbprint
    ).not.toBeUndefined();
    const bearer = await rawFetch(`${a.listener}/a2a/v1/message:send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: 'Bearer anything',
      },
      body: JSON.stringify({
        message: {
          messageId: 'm1',
          role: 'ROLE_USER',
          parts: [{ text: 'hi' }],
        },
      }),
    });
    expect(bearer.status).toBe(401);
  });

  it('pairs through a standalone host, with the reply signed for the host URL', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    expect(
      (
        await a.call('/api/a2a/listener/standalone', {
          method: 'PUT',
          body: { enabled: true },
        })
      ).status
    ).toBe(200);
    const hostPort = await freePort();
    const hostUrl = `http://127.0.0.1:${hostPort}`;
    const { token: hostToken } = (await (
      await a.call('/api/a2a/hosts', {
        body: { name: 'edge', publicUrl: hostUrl },
      })
    ).json()) as { token: string };
    const host = await startStandalone({
      host: '127.0.0.1',
      port: hostPort,
      publicUrl: null,
      tls: null,
      publicBind: false,
      trustForwardedFor: false,
      daemonUrl: a.api,
      hostToken,
      fetchImpl: rawFetch,
    });
    try {
      const res = await a.call('/api/a2a/pairings', {
        body: {
          alias: 'bob',
          cardUrl: `${hostUrl}/.well-known/agent-card.json`,
        },
      });
      expect(res.status).toBe(201);
      const { code } = (await res.json()) as { code: string };
      expect((await accept(b, code)).status).toBe(200);
      expect(a.handle.a2a.store!.getPeer('bob')?.auth).toBe('signature');
      expect(
        b.handle.a2a.store!.getPeer('alice')?.interfaceUrl.startsWith(hostUrl)
      ).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it('an expired or canceled offer cannot be accepted', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const first = await offer(a, 'bob');
    expect(
      (await a.call(`/api/a2a/pairings/${first.id}`, { method: 'DELETE' }))
        .status
    ).toBe(204);
    expect((await accept(b, first.code)).status).toBeGreaterThanOrEqual(400);
    expect(b.handle.a2a.store!.getPeer('alice')).toBeNull();
  });

  it('refuses a code whose key is not the one that signed the card', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const other = await daemon('a2a-pair-o-');
    const { code } = await offer(a);
    const decoded = JSON.parse(
      Buffer.from(
        code.slice('dispatch-a2a-pair:'.length),
        'base64url'
      ).toString()
    ) as Record<string, unknown>;
    // Point the code at another daemon's card, keeping A's key.
    const forged = `dispatch-a2a-pair:${Buffer.from(JSON.stringify({ ...decoded, reach: { kind: 'url', card: `${other.listener}/.well-known/agent-card.json` } })).toString('base64url')}`;
    const res = await accept(b, forged);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(b.handle.a2a.store!.getPeer('alice')).toBeNull();
  });

  it('a decide-tier human cannot pair with a loopback card; the operator can', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const { code } = await offer(a);
    const lead = b.handle.team.teammates.issue('ada', 'decide');
    const res = await accept(b, code, 'alice', lead);
    expect(res.status).toBe(400);
    expect(b.handle.a2a.store!.getPeer('alice')).toBeNull();
    expect((await accept(b, code)).status).toBe(200);
  });

  it('tells the offering side’s owner, naming who created the offer', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const { code } = await offer(a);
    expect((await accept(b, code)).status).toBe(200);
    const owner = (
      (await (await a.call('/api/whoami')).json()) as { ref: string }
    ).ref;
    await waitFor(
      () =>
        a.handle.messaging.engine
          .inbox(owner)
          .some(
            ({ message }) =>
              message.kind === 'notice' &&
              message.body.includes('a2a:bob paired')
          ),
      5000
    );
  });

  it('keeps the pairing routes from the agent token and request-tier teammates', async () => {
    const a = await daemon('a2a-pair-a-');
    expect(
      (
        await a.call('/api/a2a/pairings', {
          body: { alias: 'bob' },
          token: a.handle.tokens.agentToken,
        })
      ).status
    ).toBe(403);
    const member = a.handle.team.teammates.issue('bo', 'request');
    expect(
      (
        await a.call('/api/a2a/pairings', {
          body: { alias: 'bob' },
          token: member,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await a.call('/api/a2a/pairings/accept', {
          body: { code: 'x', alias: 'x' },
          token: member,
        })
      ).status
    ).toBe(403);
  });
});

describe('unpairing', () => {
  it('removing the peer on one side disables the other side’s records and tells its owner', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    const bNotices = await noticesOf(b);
    expect(
      (await a.call('/api/a2a/peers/bob', { method: 'DELETE' })).status
    ).toBe(204);
    // This side drops both records at once.
    expect(agentStatus(a, 'a2a.bob')).toBe('revoked');
    await waitFor(
      () => b.handle.a2a.store!.getPeer('alice')?.status === 'disabled',
      10_000
    );
    expect(agentStatus(b, 'a2a.alice')).toBe('revoked');
    expect(pairingState(b)).toBe('unpaired');
    await waitFor(
      () => bNotices().some((n) => n.includes('a2a:alice unpaired')),
      5000
    );
    // Told, so the sender settles: its peer row goes.
    await waitFor(() => a.handle.a2a.store!.getPeer('bob') === null, 10_000);
    expect(pairingState(a)).toBe('unpaired');
    // B's owner can then remove the disabled record.
    expect(
      (await b.call('/api/a2a/peers/alice', { method: 'DELETE' })).status
    ).toBe(204);
    expect(b.handle.a2a.store!.getPeer('alice')).toBeNull();
  });

  it('revoking the paired client unpairs too', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    const address = clientOf(a, 'a2a.bob').address;
    expect(
      (
        await a.call(`/api/agents/${encodeURIComponent(address)}/revoke`, {
          method: 'POST',
        })
      ).status
    ).toBe(200);
    await waitFor(
      () => b.handle.a2a.store!.getPeer('alice')?.status === 'disabled',
      10_000
    );
    await waitFor(() => a.handle.a2a.store!.getPeer('bob') === null, 10_000);
  });

  it('an unsigned notice, or one for an unknown pairing, is 404 and changes nothing', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    const id = b.handle.a2a.store!.pairings()[0].id;
    const unsigned = await rawFetch(`${b.listener}/a2a/v1/dispatch/unpair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({
        tag: 'dispatch-a2a-unpair-v1',
        id,
        at: new Date().toISOString(),
      }),
    });
    expect(unsigned.status).toBe(404);
    // Signed by A's real key, for a pairing B does not have.
    const key = new CardSigner(loadOrCreateSigningKey(a.root)).requestKey();
    const bKey = new CardSigner(loadOrCreateSigningKey(b.root)).publicJwk();
    const send = signedFetch(rawFetch, {
      keyid: key.keyid,
      privateKey: key.privateKey,
      peerKey: createPublicKey({ key: bKey, format: 'jwk' }),
    });
    const unknown = await send(`${b.listener}/a2a/v1/dispatch/unpair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({
        tag: 'dispatch-a2a-unpair-v1',
        id: 'A'.repeat(22),
        at: new Date().toISOString(),
      }),
    });
    expect(unknown.status).toBe(404);
    expect(b.handle.a2a.store!.getPeer('alice')?.status).toBe('active');
    expect(agentStatus(b, 'a2a.alice')).toBe('approved');
    expect(pairingState(b)).toBe('completed');
  });

  it('an open direct question to the peer closes "a2a:<alias> unpaired"', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    const owner = await ownerOf(b);
    const { message: q } = await b.handle.messaging.engine.send(
      {
        to: ['a2a:alice'],
        kind: 'question',
        blocking: true,
        body: 'Which colour?',
        choices: ['blue', 'red'],
      },
      { address: owner, canDecide: true }
    );
    await waitFor(
      () => b.handle.a2a.store!.getOutbound(q.id, 'alice')?.state === 'open',
      15_000
    );
    expect(
      (await a.call('/api/a2a/peers/bob', { method: 'DELETE' })).status
    ).toBe(204);
    await waitFor(
      () => b.handle.messaging.engine.answerOf(q.id) !== null,
      10_000
    );
    expect(b.handle.messaging.engine.answerOf(q.id)?.body).toBe(
      'Closed: a2a:alice unpaired'
    );
  });

  it('revoking the teammate who created a pairing unpairs both sides (XH-R3)', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const ada = a.handle.team.teammates.issue('ada', 'operator');
    await paired(a, b, ada);
    expect(clientOf(a, 'a2a.bob').address).toBe('agent:ada/a2a.bob');
    expect(
      (await a.call('/api/team/tokens/ada', { method: 'DELETE' })).status
    ).toBe(200);
    await waitFor(
      () => b.handle.a2a.store!.getPeer('alice')?.status === 'disabled',
      10_000
    );
    await waitFor(() => a.handle.a2a.store!.getPeer('bob') === null, 10_000);
  });

  it('an unpair the other side cannot hear yet parks this side’s rows until it settles', async () => {
    const a = await daemon('a2a-pair-a-', { noticeBackoffMs: [300, 300] });
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    await stop(b);
    const owner = await ownerOf(a);
    const { message } = await a.handle.messaging.engine.send(
      { to: ['a2a:bob'], kind: 'message', body: 'Are you there?' },
      { address: owner, canDecide: true }
    );
    await waitFor(
      () =>
        a.handle.a2a.store!.getOutbound(message.id, 'bob')?.state === 'queued',
      10_000
    );
    expect(
      (await a.call('/api/a2a/peers/bob', { method: 'DELETE' })).status
    ).toBe(204);
    // In flight: the peer row and its queued mail stay, disabled.
    expect(a.handle.a2a.store!.getPeer('bob')?.status).toBe('disabled');
    expect(pairingState(a)).toBe('unpairing');
    expect(a.handle.a2a.store!.getOutbound(message.id, 'bob')?.state).toBe(
      'queued'
    );
    // Out of attempts: it settles, and the owner hears the other side was not told.
    const aNotices = await noticesOf(a);
    await waitFor(() => a.handle.a2a.store!.getPeer('bob') === null, 10_000);
    expect(pairingState(a)).toBe('unpaired');
    expect(a.handle.a2a.store!.getOutbound(message.id, 'bob')?.state).toBe(
      'failed'
    );
    await waitFor(
      () => aNotices().some((n) => n.includes('could not tell')),
      5000
    );
  });
});

describe('batch 3 review: K1, M2, M4, M5', () => {
  it('K1: revoking a teammate cancels their open offers', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const ada = a.handle.team.teammates.issue('ada', 'operator');
    const { code, id } = await offer(a, 'bob', ada);
    expect(
      (await a.call('/api/team/tokens/ada', { method: 'DELETE' })).status
    ).toBe(200);
    expect(a.handle.a2a.store!.pairing(id)?.state).toBe('canceled');
    expect((await accept(b, code)).status).toBeGreaterThanOrEqual(400);
    expect(a.handle.a2a.store!.getPeer('bob')).toBeNull();
  });

  it('K1: completion re-checks the creator, revoked without a cascade or lowered in tier', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const ada = a.handle.team.teammates.issue('ada', 'operator');
    const first = await offer(a, 'bob', ada);
    // Lowered to decide: the operator-tier offer no longer stands.
    a.handle.team.teammates.issue('ada', 'decide');
    expect((await accept(b, first.code)).status).toBeGreaterThanOrEqual(400);
    expect(a.handle.a2a.store!.getPeer('bob')).toBeNull();
    // Revoked without the cascade (a race with it): refused too.
    const again = a.handle.team.teammates.issue('ada', 'operator');
    const second = await offer(a, 'bob2', again);
    a.handle.team.teammates.revoke('ada');
    expect(
      (await accept(b, second.code, 'alice2')).status
    ).toBeGreaterThanOrEqual(400);
    expect(a.handle.a2a.store!.getPeer('bob2')).toBeNull();
    expect(a.handle.a2a.store!.clients()).toEqual([]);
  });

  it('M2: refuses an alias that already has an open offer, on either side', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await offer(a, 'bob');
    expect(
      (await a.call('/api/a2a/pairings', { body: { alias: 'bob' } })).status
    ).toBe(409);
    // B has an open offer under the alias it would accept as.
    await offer(b, 'alice');
    const { code } = await offer(a, 'carol');
    expect((await accept(b, code, 'alice')).status).toBe(409);
  });

  it('M2: a peer row that appears before completion stops it, and nothing else is written', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    const { code, id } = await offer(a, 'bob');
    // Someone adds a2a:bob on A between the offer and the proof.
    a.handle.a2a.store!.putPeer({
      alias: 'bob',
      cardUrl: 'https://bob.example.com/.well-known/agent-card.json',
      interfaceUrl: 'https://bob.example.com/a2a/v1',
      binding: 'HTTP+JSON',
      cardJson: '{}',
      etag: null,
      fetchedAt: new Date().toISOString(),
      status: 'active',
      addedBy: 'human:test',
      addedTier: 'operator',
      allowHttp: false,
      allowOrigin: false,
      apiKeyHeader: null,
      createdAt: new Date().toISOString(),
    });
    expect((await accept(b, code)).status).toBeGreaterThanOrEqual(400);
    expect(
      a.handle.a2a.store!.getPeer('bob')?.keyThumbprint ?? null
    ).toBeNull();
    expect(a.handle.a2a.store!.clients()).toEqual([]);
    expect(a.handle.a2a.store!.pairing(id)?.state).toBe('offered');
  });

  it('M4: an unreachable accepting card gets a fixed message, not the error', async () => {
    const a = await daemon('a2a-pair-a-');
    const { code } = await offer(a, 'bob');
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const proof = makeProof({
      code: decodePairingCode(code, new Date()),
      reach: {
        kind: 'url',
        card: `http://127.0.0.1:${await freePort()}/.well-known/agent-card.json`,
      },
      name: 'Bob',
      privateKey,
      jwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
    });
    const res = await rawFetch(`${a.listener}/a2a/v1/dispatch/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify(proof),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("the accepting side's card could not be checked");
    expect(text).not.toMatch(/127\.0\.0\.1|connection|refused|fetch/i);
  });

  it('M5: a restart resumes an unpair at its attempt count, not from zero', async () => {
    // One retry, a minute out: only a kept count lets it give up after a restart.
    const a = await daemon('a2a-pair-a-', { noticeBackoffMs: [60_000] });
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    await stop(b);
    expect(
      (await a.call('/api/a2a/peers/bob', { method: 'DELETE' })).status
    ).toBe(204);
    await waitFor(
      () => (a.handle.a2a.store!.notices('unpair')[0]?.attempts ?? 0) >= 1,
      10_000
    );
    await restart(a, { noticeBackoffMs: [60_000] });
    await waitFor(() => a.handle.a2a.store!.getPeer('bob') === null, 10_000);
    expect(pairingState(a)).toBe('unpaired');
    expect(a.handle.a2a.store!.notices('unpair')).toEqual([]);
  });
});

describe('what the API shows of pairings and keys (T46)', () => {
  it('peer rows say how they are reached and whose key they pin', async () => {
    const a = await daemon('a2a-pair-a-');
    const b = await daemon('a2a-pair-b-');
    await paired(a, b);
    const { peers } = (await (await a.call('/api/a2a/peers')).json()) as {
      peers: { alias: string; auth: string; fingerprint: string | null }[];
    };
    expect(peers).toEqual([
      expect.objectContaining({
        alias: 'bob',
        auth: 'signature',
        fingerprint: a2aFingerprint(loadOrCreateSigningKey(b.root).kid),
      }),
    ]);
  });

  it('GET /api/a2a/keys shows the key, any rotation in its overlap, on the agent token too', async () => {
    const a = await daemon('a2a-pair-a-');
    const kid = loadOrCreateSigningKey(a.root).kid;
    const read = async (token?: string) => {
      const res = await a.call(
        '/api/a2a/keys',
        token === undefined ? {} : { token }
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        current: { fingerprint: string; thumbprint: string };
        next: { fingerprint: string; since: string; until: string } | null;
      };
    };
    expect(await read(a.handle.tokens.agentToken)).toEqual({
      current: { fingerprint: a2aFingerprint(kid), thumbprint: kid },
      next: null,
    });
    expect((await a.call('/api/a2a/keys/rotate', { body: {} })).status).toBe(
      200
    );
    const after = await read();
    expect(after.current.fingerprint).toBe(a2aFingerprint(kid));
    expect(after.next?.fingerprint).not.toBe(a2aFingerprint(kid));
  });
});

describe('batch 4 review K1 nit: the creator is checked before any fetch', () => {
  it('a revoked creator’s offer completes nothing and fetches nothing', async () => {
    const a = await daemon('a2a-pair-a-');
    const ada = a.handle.team.teammates.issue('ada', 'operator');
    const { code } = await offer(a, 'bob', ada);
    a.handle.team.teammates.revoke('ada');
    let fetches = 0;
    const card = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        fetches++;
        return new Response('{}');
      },
    });
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
      });
      const proof = makeProof({
        code: decodePairingCode(code, new Date()),
        reach: {
          kind: 'url',
          card: `http://127.0.0.1:${card.port}/.well-known/agent-card.json`,
        },
        name: 'Bob',
        privateKey,
        jwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
      });
      const res = await rawFetch(`${a.listener}/a2a/v1/dispatch/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: JSON.stringify(proof),
      });
      expect(res.status).toBe(404);
      expect(fetches).toBe(0);
    } finally {
      await card.stop(true);
    }
  });
});
