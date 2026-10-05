import { a2aFingerprint, SIG_EXTENSION_URI } from '@dispatch/a2a';
import { readPeerCredential } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadOrCreateSigningKey } from '../../src/a2a/signing.js';
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
