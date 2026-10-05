import { decodePairingCode, makeProof, startStandalone } from '@dispatch/a2a';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';
import { freePort } from './seed.js';

interface Daemon {
  handle: ServerHandle;
  root: string;
  api: string;
  listener: string;
  // An /api call as the owner (the operator tier).
  call(
    path: string,
    init?: { method?: string; body?: unknown; token?: string }
  ): Promise<Response>;
}

let home: string;
let daemons: Daemon[] = [];
const originalHome = process.env.DISPATCH_HOME;

// A daemon on its own scratch root with its A2A listener open on loopback.
async function daemon(prefix: string): Promise<Daemon> {
  const root = initGitRepo(prefix);
  TaskStore.init(root);
  const handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  const api = `http://127.0.0.1:${handle.port}`;
  const call: Daemon['call'] = (path, init = {}) =>
    rawFetch(`${api}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${init.token ?? handle.tokens.appToken}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const port = await freePort();
  const put = await call('/api/a2a/listener', {
    method: 'PUT',
    body: { enabled: true, host: '127.0.0.1', port },
  });
  expect(put.status).toBe(200);
  const d = { handle, root, api, listener: `http://127.0.0.1:${port}`, call };
  daemons.push(d);
  return d;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-pairing-home-')));
  process.env.DISPATCH_HOME = home;
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) {
    await d.handle.stop();
    rmSync(d.root, { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function offer(a: Daemon, alias = 'bob') {
  const res = await a.call('/api/a2a/pairings', { body: { alias } });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    code: string;
    fingerprint: string;
    expiresAt: string;
  };
}

const accept = (b: Daemon, code: string, alias = 'alice', token?: string) =>
  b.call('/api/a2a/pairings/accept', {
    body: { code, alias },
    ...(token === undefined ? {} : { token }),
  });

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
