import { signRequest, startRelay } from '@dispatch/a2a';
import { describe, expect, it } from 'bun:test';
import { createPrivateKey } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrCreateSigningKey } from '../../src/a2a/signing.js';
import { waitFor } from '../messaging/harness.js';
import { rawFetch } from '../testAuth.js';
import type { Daemon } from './pairHarness.js';
import { ownerOf, useDaemons } from './pairHarness.js';

const { daemon } = useDaemons();

interface RelayStatus {
  enabled: boolean;
  url: string | null;
  connected: boolean;
  tenantUrl: string | null;
  error: string | null;
}

// An in-process relay admitting `daemons`, and its access log.
async function relayFor(daemons: Daemon[], port = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-relay-e2e-'));
  const tenants = join(dir, 'tenants');
  writeFileSync(
    tenants,
    daemons.map((d) => `${loadOrCreateSigningKey(d.root).kid}\n`).join('')
  );
  chmodSync(tenants, 0o600);
  const lines: string[] = [];
  const relay = await startRelay({
    host: '127.0.0.1',
    port,
    publicUrl: null,
    tls: null,
    publicBind: false,
    trustForwardedFor: false,
    tenantsFile: tenants,
    log: (line) => lines.push(line),
  });
  return {
    relay,
    lines,
    stop: async () => {
      await relay.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function connect(d: Daemon, url: string): Promise<RelayStatus> {
  const res = await d.call('/api/a2a/relay', {
    method: 'PUT',
    body: { enabled: true, url },
  });
  expect(res.status).toBe(200);
  await waitFor(() => relayStatus(d).connected, 10_000);
  // The API reports what the bridge does.
  const shown = (await (await d.call('/api/a2a/relay')).json()) as RelayStatus;
  expect(shown).toEqual(relayStatus(d));
  return shown;
}

const relayStatus = (d: Daemon): RelayStatus => d.handle.a2a.relayStatus();

async function bearerClient(d: Daemon, name: string): Promise<string> {
  const res = await d.call('/api/a2a/clients', {
    body: { name, approve: true },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

const ask = (url: string, token: string, text: string) =>
  rawFetch(`${url}/a2a/v1/message:send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: {
        messageId: `m-${Math.random().toString(36).slice(2)}`,
        role: 'ROLE_USER',
        parts: [{ text }],
      },
      configuration: { returnImmediately: true },
    }),
  });

describe('daemons reached through an A2A relay', () => {
  it('serves each daemon at its tenant URL, pairs through the relay, and keeps tenants apart', async () => {
    const a = await daemon('a2a-relay-a-');
    const b = await daemon('a2a-relay-b-');
    const r = await relayFor([a, b]);
    try {
      const sa = await connect(a, r.relay.url);
      const sb = await connect(b, r.relay.url);
      expect(sa.tenantUrl).toBe(
        `${r.relay.url}/t/${loadOrCreateSigningKey(a.root).kid}`
      );
      // A plain client asks each daemon through its tenant URL.
      const tokenA = await bearerClient(a, 'outside-a');
      const tokenB = await bearerClient(b, 'outside-b');
      expect((await ask(sa.tenantUrl!, tokenA, 'Hello A.')).status).toBe(200);
      expect((await ask(sb.tenantUrl!, tokenB, 'Hello B.')).status).toBe(200);
      // A's token means nothing at B's URL.
      expect((await ask(sb.tenantUrl!, tokenA, 'Wrong door.')).status).toBe(
        401
      );
      // The card at the tenant URL is built for it.
      const card = (await (
        await rawFetch(`${sa.tenantUrl}/.well-known/agent-card.json`)
      ).json()) as { supportedInterfaces: { url: string }[] };
      expect(card.supportedInterfaces[0].url).toBe(`${sa.tenantUrl}/a2a/v1`);

      // Pairing through the relay: each side's reach is its tenant card.
      const offered = await a.call('/api/a2a/pairings', {
        body: {
          alias: 'bob',
          cardUrl: `${sa.tenantUrl}/.well-known/agent-card.json`,
        },
      });
      expect(offered.status).toBe(201);
      const { code } = (await offered.json()) as { code: string };
      const accepted = await b.call('/api/a2a/pairings/accept', {
        body: {
          code,
          alias: 'alice',
          cardUrl: `${sb.tenantUrl}/.well-known/agent-card.json`,
        },
      });
      expect(accepted.status).toBe(200);
      // B asks A, signed, through the relay (verified against A's tenant URL).
      const { message } = await b.handle.messaging.engine.send(
        { to: ['a2a:alice'], kind: 'message', body: 'Signed via the relay.' },
        { address: await ownerOf(b), canDecide: true }
      );
      await waitFor(
        () =>
          b.handle.a2a.store!.getOutbound(message.id, 'alice')?.state ===
          'done',
        20_000
      );
      // A request B signed for the bare relay origin is refused at A's URL.
      const bKey = loadOrCreateSigningKey(b.root);
      const body = JSON.stringify({
        message: {
          messageId: 'm-wrong-origin',
          role: 'ROLE_USER',
          parts: [{ text: 'x' }],
        },
      });
      const headers = new Headers({
        'content-type': 'application/json',
        'a2a-version': '1.0',
      });
      const signed = signRequest({
        method: 'POST',
        targetUri: `${r.relay.url}/a2a/v1/message:send`,
        headers,
        body: new TextEncoder().encode(body),
        keyid: bKey.kid,
        privateKey: createPrivateKey({ key: bKey.privateJwk, format: 'jwk' }),
        now: new Date(),
      });
      for (const [k, v] of Object.entries(signed)) headers.set(k, v);
      const wrong = await rawFetch(`${sa.tenantUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers,
        body,
      });
      expect(wrong.status).toBe(401);

      // A leaves the relay: A's URLs are 503, B still serves.
      expect(
        (await a.call('/api/a2a/relay', { method: 'DELETE' })).status
      ).toBe(200);
      await waitFor(() => !relayStatus(a).connected, 5000);
      expect(
        (await rawFetch(`${sa.tenantUrl}/.well-known/agent-card.json`)).status
      ).toBe(503);
      expect((await ask(sb.tenantUrl!, tokenB, 'Still here?')).status).toBe(
        200
      );

      // The relay's log names routes and statuses, never credentials.
      const log = r.lines.join('\n');
      expect(log).toContain('/a2a/v1/message:send');
      for (const secret of [tokenA, tokenB]) expect(log).not.toContain(secret);
    } finally {
      await r.stop();
    }
  }, 90_000);

  it('re-dials with backoff after the relay restarts', async () => {
    const a = await daemon('a2a-relay-a-');
    const first = await relayFor([a]);
    const port = first.relay.port;
    await connect(a, first.relay.url);
    await first.stop();
    await waitFor(() => !relayStatus(a).connected, 5000);
    const second = await relayFor([a], port);
    try {
      await waitFor(() => relayStatus(a).connected, 15_000);
    } finally {
      await second.stop();
    }
  }, 40_000);

  it('only the operator sets the relay; anyone may read it', async () => {
    const a = await daemon('a2a-relay-a-');
    const lead = a.handle.team.teammates.issue('ada', 'decide');
    expect(
      (
        await a.call('/api/a2a/relay', {
          method: 'PUT',
          body: { enabled: true, url: 'https://relay.example.com' },
          token: lead,
        })
      ).status
    ).toBe(403);
    expect(
      (await a.call('/api/a2a/relay', { token: a.handle.tokens.agentToken }))
        .status
    ).toBe(200);
    // Not https and not loopback: refused.
    expect(
      (
        await a.call('/api/a2a/relay', {
          method: 'PUT',
          body: { enabled: true, url: 'http://relay.example.com' },
        })
      ).status
    ).toBe(400);
  });
});
