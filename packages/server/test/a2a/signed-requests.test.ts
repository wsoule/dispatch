import {
  ecThumbprint,
  PORT_CLIENT_HEADER,
  signRequest,
  signResponseFor,
  startStandalone,
  verifyRequest,
  verifyResponse,
} from '@dispatch/a2a';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let base: string;
let listenerUrl: string;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

interface SigningKey {
  privateKey: KeyObject;
  jwk: Record<string, string>;
  keyid: string;
}

function newKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { privateKey, jwk, keyid: ecThumbprint(jwk)! };
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-signed-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-signed-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
  useSeedBase(base);
  const port = await freePort();
  const put = await fetch(`${base}/api/a2a/listener`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ enabled: true, host: '127.0.0.1', port }),
  });
  expect(put.status).toBe(200);
  listenerUrl = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// An approved client whose card key is pinned, so it must sign.
async function signatureClient(name: string, key = newKey()) {
  const { caller, token } = await approvedClient(name);
  handle.a2a.store!.setClientKey(caller.address, {
    thumbprint: key.keyid,
    jwk: key.jwk,
    auth: 'signature',
    pairedId: null,
  });
  return { caller, token, key };
}

const send = (messageId: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{ text: 'Is it signed?' }],
      },
      configuration: { returnImmediately: true },
    })
  );

// The headers a Dispatch peer sends with a signed request to `origin`.
function signedHeaders(
  key: SigningKey,
  method: string,
  url: string,
  body: Uint8Array | null,
  extra: Record<string, string> = {}
): Headers {
  const headers = new Headers({
    'a2a-version': '1.0',
    ...(body === null ? {} : { 'content-type': 'application/json' }),
    ...extra,
  });
  const out = signRequest({
    method,
    targetUri: url,
    headers,
    body,
    keyid: key.keyid,
    privateKey: key.privateKey,
    now: new Date(),
  });
  for (const [k, v] of Object.entries(out)) headers.set(k, v);
  return headers;
}

const postSigned = (
  key: SigningKey,
  messageId: string,
  signedFor = listenerUrl
) => {
  const body = send(messageId);
  return rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
    method: 'POST',
    headers: signedHeaders(
      key,
      'POST',
      `${signedFor}/a2a/v1/message:send`,
      body
    ),
    body,
  });
};

describe('signed requests on the listener', () => {
  it('accepts a signed ask from a signature client, as that client', async () => {
    const { caller, key } = await signatureClient('acme');
    const res = await postSigned(key, 'm-signed-1');
    expect(res.status).toBe(200);
    const task = ((await res.json()) as { task: { id: string } }).task;
    expect(handle.a2a.store!.getTask(task.id)?.client).toBe(caller.address);
    const get = await rawFetch(`${listenerUrl}/a2a/v1/tasks/${task.id}`, {
      headers: signedHeaders(
        key,
        'GET',
        `${listenerUrl}/a2a/v1/tasks/${task.id}`,
        null
      ),
    });
    expect(get.status).toBe(200);
  });

  it('a request signed for another origin is refused', async () => {
    const { key } = await signatureClient('acme');
    expect((await postSigned(key, 'm-1', 'http://evil.example')).status).toBe(
      401
    );
  });

  it('refuses a replayed signature within its window', async () => {
    const { key } = await signatureClient('acme');
    const body = send('m-replay');
    const headers = signedHeaders(
      key,
      'POST',
      `${listenerUrl}/a2a/v1/message:send`,
      body
    );
    const once = () =>
      rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers,
        body,
      });
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(401);
  });

  it('refuses a key it has not pinned, and a revoked client even when signed', async () => {
    await signatureClient('acme');
    expect((await postSigned(newKey(), 'm-1')).status).toBe(401);
    const { caller, key } = await signatureClient('beta');
    await fetch(
      `${base}/api/agents/${encodeURIComponent(caller.address)}/revoke`,
      {
        method: 'POST',
      }
    );
    expect((await postSigned(key, 'm-2')).status).toBe(401);
  });

  it('never lets a signature stand in for a bearer client, and leaves the bearer path as it was', async () => {
    const { token } = await approvedClient('plain');
    const body = send('m-plain');
    const plain = await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
      method: 'POST',
      headers: {
        ...json,
        'a2a-version': '1.0',
        authorization: `Bearer ${token}`,
      },
      body,
    });
    expect(plain.status).toBe(200);
    // A tagged signature decides on its own: a junk key fails even with a valid bearer.
    const headers = signedHeaders(
      newKey(),
      'POST',
      `${listenerUrl}/a2a/v1/message:send`,
      send('m-x'),
      {
        authorization: `Bearer ${token}`,
      }
    );
    const both = await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
      method: 'POST',
      headers,
      body: send('m-x'),
    });
    expect(both.status).toBe(401);
  });

  it('logs the refusal class and never the signature', async () => {
    const { key } = await signatureClient('acme');
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      })
    );
    let signature = '';
    try {
      const body = send('m-stale');
      const headers = signedHeaders(
        key,
        'POST',
        `${listenerUrl}/a2a/v1/message:send`,
        body
      );
      signature = headers.get('signature')!;
      await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers,
        body,
      });
      await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers,
        body,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const all = logged.join('\n');
    expect(all).toContain('sig_replay');
    expect(all).not.toContain(signature.slice(4, 40));
  });
});

describe('a signature client on every surface', () => {
  const RELAY = 'https://relay.example.com';

  async function host() {
    await fetch(`${base}/api/a2a/listener/standalone`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: true }),
    });
    return (
      (await (
        await fetch(`${base}/api/a2a/hosts`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ name: 'relay', publicUrl: RELAY }),
        })
      ).json()) as { token: string }
    ).token;
  }

  // What a standalone host forwards: the client's request, as received.
  function forwarded(key: SigningKey, signedFor = RELAY) {
    const body = send('m-host');
    const headers = signedHeaders(
      key,
      'POST',
      `${signedFor}/a2a/v1/message:send`,
      body
    );
    return {
      method: 'POST',
      path: '/a2a/v1/message:send',
      query: '',
      headers: Object.fromEntries(
        [
          'signature-input',
          'signature',
          'content-digest',
          'content-type',
          'a2a-version',
        ].map((h) => [h, headers.get(h) ?? ''])
      ),
      body: Buffer.from(body).toString('base64'),
    };
  }

  it('a signature client refuses a bearer on every surface', async () => {
    const { token, key } = await signatureClient('acme');
    const hostToken = await host();
    // The listener.
    expect(
      (
        await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
          method: 'POST',
          headers: {
            ...json,
            'a2a-version': '1.0',
            authorization: `Bearer ${token}`,
          },
          body: send('m-bearer'),
        })
      ).status
    ).toBe(401);
    // The standalone port, with the client's bearer forwarded.
    const viaHost = await rawFetch(`${base}/api/a2a/port/whoami`, {
      headers: {
        authorization: `Bearer ${hostToken}`,
        [PORT_CLIENT_HEADER]: `Bearer ${token}`,
      },
    });
    expect(((await viaHost.json()) as { ok: boolean }).ok).toBe(false);
    // And signed through the host, verified against the host's pinned URL.
    const signed = await rawFetch(`${base}/api/a2a/port/authenticate-signed`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${hostToken}` },
      body: JSON.stringify(forwarded(key)),
    });
    expect(signed.status).toBe(200);
    const result = (await signed.json()) as {
      ok: true;
      caller: { address: string; credential: string };
    };
    expect(result.ok).toBe(true);
    const tasks = await rawFetch(`${base}/api/a2a/port/tasks`, {
      headers: {
        authorization: `Bearer ${hostToken}`,
        [PORT_CLIENT_HEADER]: result.caller.credential,
      },
    });
    expect(tasks.status).toBe(200);
  });

  it('through a host, refuses a request signed for any URL but the host’s pinned one', async () => {
    const { key } = await signatureClient('acme');
    const hostToken = await host();
    const res = await rawFetch(`${base}/api/a2a/port/authenticate-signed`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${hostToken}` },
      body: JSON.stringify(forwarded(key, listenerUrl)),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('a signed session works only for the host that opened it', async () => {
    const { key } = await signatureClient('acme');
    const hostToken = await host();
    const other = (
      (await (
        await fetch(`${base}/api/a2a/hosts`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            name: 'other',
            publicUrl: 'https://other.example.com',
          }),
        })
      ).json()) as { token: string }
    ).token;
    const signed = (await (
      await rawFetch(`${base}/api/a2a/port/authenticate-signed`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${hostToken}` },
        body: JSON.stringify(forwarded(key)),
      })
    ).json()) as { caller: { credential: string } };
    const res = await rawFetch(`${base}/api/a2a/port/tasks`, {
      headers: {
        authorization: `Bearer ${other}`,
        [PORT_CLIENT_HEADER]: signed.caller.credential,
      },
    });
    expect(res.status).toBe(401);
  });
});

// The daemon's card key, as its JWKS publishes it.
async function daemonKey(): Promise<KeyObject> {
  const jwks = (await (
    await rawFetch(`${listenerUrl}/.well-known/jwks.json`)
  ).json()) as { keys: Record<string, string>[] };
  return createPublicKey({ key: jwks.keys[0], format: 'jwk' });
}

describe('signed responses and outbound signing (T40)', () => {
  it('the listener signs its response to a signed request, bound to that request', async () => {
    const { key } = await signatureClient('acme');
    const body = send('m-resp');
    const headers = signedHeaders(
      key,
      'POST',
      `${listenerUrl}/a2a/v1/message:send`,
      body
    );
    const res = await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
      method: 'POST',
      headers,
      body,
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pub = await daemonKey();
    const kid = ecThumbprint(
      pub.export({ format: 'jwk' }) as Record<string, string>
    )!;
    const verdict = verifyResponse(
      { status: res.status, headers: res.headers, body: bytes },
      {
        method: 'POST',
        targetUri: `${listenerUrl}/a2a/v1/message:send`,
        headers,
      },
      {
        keyFor: (id) => (id === kid ? pub : null),
        now: new Date(),
        guardMs: 300_000,
      }
    );
    expect(verdict).toEqual({ ok: true, keyid: kid });
  });

  it('signs requests to a pinned peer and reads its signed reply; an unsigned reply marks it auth-failed', async () => {
    const peerKey = newKey();
    let mode: 'signed' | 'unsigned' | 'signed401' = 'signed';
    let verified = 0;
    const daemonPub = await daemonKey();
    const daemonKid = ecThumbprint(
      daemonPub.export({ format: 'jwk' }) as Record<string, string>
    )!;
    const seen = new Set<string>();
    const peer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/.well-known/agent-card.json')
          return Response.json({
            name: 'Signed peer',
            description: 'A fixture.',
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
        const body =
          req.method === 'GET' ? null : new Uint8Array(await req.arrayBuffer());
        const ok = verifyRequest(
          {
            method: req.method,
            path: url.pathname,
            query: url.search,
            headers: req.headers,
            body,
          },
          {
            configuredOrigin: url.origin,
            keyFor: (id) => (id === daemonKid ? daemonPub : null),
            now: new Date(),
            guardMs: 300_000,
            rememberNonce: (_id, n) =>
              seen.has(n) ? 'replay' : (seen.add(n), 'fresh'),
          }
        );
        if (!ok.ok) return new Response(ok.reason, { status: 401 });
        verified += 1;
        if (req.headers.get('authorization') !== null)
          return new Response('no bearer to a signature peer', { status: 400 });
        const reply =
          mode === 'signed401'
            ? new Response(
                JSON.stringify({
                  error: {
                    code: 401,
                    status: 'UNAUTHENTICATED',
                    message: 'revoked',
                    details: [
                      {
                        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                        reason: 'AUTH_AGENT_REVOKED',
                        domain: 'dispatch.foo',
                      },
                    ],
                  },
                }),
                { status: 401, headers: { 'content-type': 'application/json' } }
              )
            : new Response(
                JSON.stringify({
                  message: {
                    messageId: `r-${verified}`,
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'Signed and answered.' }],
                  },
                }),
                { headers: { 'content-type': 'application/json' } }
              );
        if (mode === 'unsigned') return reply;
        return signResponseFor(
          reply,
          { method: req.method, targetUri: req.url, headers: req.headers },
          peerKey
        );
      },
    });
    try {
      const origin = `http://127.0.0.1:${peer.port}`;
      const added = await fetch(`${base}/api/a2a/peers`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          alias: 'signed',
          cardUrl: `${origin}/.well-known/agent-card.json`,
          token: 'unused',
        }),
      });
      expect(added.status).toBe(201);
      expect(
        handle.a2a.store!.setPeerKey('signed', {
          thumbprint: peerKey.keyid,
          jwk: peerKey.jwk,
          auth: 'signature',
          pairedId: null,
        })
      ).toBe(true);
      const { message } = await handle.messaging.engine.send(
        { to: ['a2a:signed'], kind: 'message', body: 'Hello, signed peer.' },
        { address: 'human:test', canDecide: true }
      );
      await waitFor(
        () =>
          handle.a2a.store!.getOutbound(message.id, 'signed')?.state === 'done',
        10_000
      );
      expect(verified).toBe(1);
      // Review J1: an unsigned reply is unverifiable, so it retries; the peer stays active.
      mode = 'unsigned';
      const { message: again } = await handle.messaging.engine.send(
        { to: ['a2a:signed'], kind: 'message', body: 'Again.' },
        { address: 'human:test', canDecide: true }
      );
      await waitFor(
        () =>
          (handle.a2a.store!.getOutbound(again.id, 'signed')?.attempts ?? 0) >=
          1,
        10_000
      );
      expect(handle.a2a.store!.getOutbound(again.id, 'signed')).toMatchObject({
        state: 'queued',
      });
      expect(handle.a2a.store!.getPeer('signed')?.status).toBe('active');
      // A verified refusal of our credential is final.
      mode = 'signed401';
      await handle.messaging.engine.send(
        { to: ['a2a:signed'], kind: 'message', body: 'Third.' },
        { address: 'human:test', canDecide: true }
      );
      await waitFor(
        () => handle.a2a.store!.getPeer('signed')?.status === 'auth-failed',
        10_000
      );
    } finally {
      await peer.stop(true);
    }
  });

  it('a signed client works end to end through a standalone host, and the reply is signed for the host URL', async () => {
    const { key } = await signatureClient('acme');
    await fetch(`${base}/api/a2a/listener/standalone`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: true }),
    });
    const relayPort = await freePort();
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    const { token: hostToken } = (await (
      await fetch(`${base}/api/a2a/hosts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'relay', publicUrl: relayUrl }),
      })
    ).json()) as { token: string };
    const relay = await startStandalone({
      host: '127.0.0.1',
      port: relayPort,
      publicUrl: null,
      tls: null,
      publicBind: false,
      trustForwardedFor: false,
      daemonUrl: base,
      hostToken,
      fetchImpl: rawFetch,
    });
    try {
      const body = send('m-relay');
      const headers = signedHeaders(
        key,
        'POST',
        `${relayUrl}/a2a/v1/message:send`,
        body
      );
      const res = await rawFetch(`${relayUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers,
        body,
      });
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pub = await daemonKey();
      const kid = ecThumbprint(
        pub.export({ format: 'jwk' }) as Record<string, string>
      )!;
      expect(
        verifyResponse(
          { status: res.status, headers: res.headers, body: bytes },
          {
            method: 'POST',
            targetUri: `${relayUrl}/a2a/v1/message:send`,
            headers,
          },
          {
            keyFor: (id) => (id === kid ? pub : null),
            now: new Date(),
            guardMs: 300_000,
          }
        ).ok
      ).toBe(true);
      // A bearer for the same client is refused through the host too.
      const bearer = await rawFetch(`${relayUrl}/a2a/v1/message:send`, {
        method: 'POST',
        headers: {
          ...json,
          'a2a-version': '1.0',
          authorization: 'Bearer not-it',
        },
        body: send('m-relay-2'),
      });
      expect(bearer.status).toBe(401);
    } finally {
      await relay.stop();
    }
  });
});

describe('review J1, N1, N2', () => {
  const RELAY = 'https://relay.example.com';
  const covered = [
    'signature-input',
    'signature',
    'content-digest',
    'content-type',
    'a2a-version',
  ];
  const forward = (h: Headers, b: Uint8Array) => ({
    method: 'POST',
    path: '/a2a/v1/message:send',
    query: '',
    headers: Object.fromEntries(covered.map((n) => [n, h.get(n) ?? ''])),
    body: Buffer.from(b).toString('base64'),
  });
  async function hostToken(): Promise<string> {
    await fetch(`${base}/api/a2a/listener/standalone`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: true }),
    });
    const res = await fetch(`${base}/api/a2a/hosts`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'relay', publicUrl: RELAY }),
    });
    return ((await res.json()) as { token: string }).token;
  }
  async function openSession(
    token: string,
    key: SigningKey,
    messageId: string
  ) {
    const b = send(messageId);
    const h = signedHeaders(key, 'POST', `${RELAY}/a2a/v1/message:send`, b);
    const res = await rawFetch(`${base}/api/a2a/port/authenticate-signed`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${token}` },
      body: JSON.stringify(forward(h, b)),
    });
    const opened = (await res.json()) as { caller: { credential: string } };
    return { credential: opened.caller.credential, headers: h, body: b };
  }

  it('signs a revoked client’s 401, so its peer can trust the refusal', async () => {
    const { caller, key } = await signatureClient('acme');
    await fetch(
      `${base}/api/agents/${encodeURIComponent(caller.address)}/revoke`,
      { method: 'POST' }
    );
    const body = send('m-revoked');
    const headers = signedHeaders(
      key,
      'POST',
      `${listenerUrl}/a2a/v1/message:send`,
      body
    );
    const res = await rawFetch(`${listenerUrl}/a2a/v1/message:send`, {
      method: 'POST',
      headers,
      body,
    });
    expect(res.status).toBe(401);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pub = await daemonKey();
    const kid = ecThumbprint(
      pub.export({ format: 'jwk' }) as Record<string, string>
    )!;
    expect(
      verifyResponse(
        { status: 401, headers: res.headers, body: bytes },
        {
          method: 'POST',
          targetUri: `${listenerUrl}/a2a/v1/message:send`,
          headers,
        },
        {
          keyFor: (id) => (id === kid ? pub : null),
          now: new Date(),
          guardMs: 300_000,
        }
      ).ok
    ).toBe(true);
  });

  it('N1: a session and a stream re-check go by the key that signed, not the row', async () => {
    const { caller, key } = await signatureClient('acme');
    expect(
      await handle.a2a.port!.revalidate({ ...caller, keyid: key.keyid })
    ).toBe(true);
    const token = await hostToken();
    const { credential } = await openSession(token, key, 'm-n1');
    const tasks = () =>
      rawFetch(`${base}/api/a2a/port/tasks`, {
        headers: {
          authorization: `Bearer ${token}`,
          [PORT_CLIENT_HEADER]: credential,
        },
      });
    expect((await tasks()).status).toBe(200);
    // The client row is re-pinned to another key (a rotation, say).
    const next = newKey();
    expect(
      handle.a2a.store!.setClientKey(caller.address, {
        thumbprint: next.keyid,
        jwk: next.jwk,
        auth: 'signature',
        pairedId: null,
      })
    ).toBe(true);
    expect((await tasks()).status).toBe(401);
    expect(
      await handle.a2a.port!.revalidate({ ...caller, keyid: key.keyid })
    ).toBe(false);
  });

  it('N2: a host’s reply is signed only for the request its session opened on', async () => {
    const { key } = await signatureClient('acme');
    const token = await hostToken();
    const first = await openSession(token, key, 'm-n2-a');
    const signFor = (h: Headers, b: Uint8Array) =>
      rawFetch(`${base}/api/a2a/port/sign-response`, {
        method: 'POST',
        headers: {
          ...json,
          authorization: `Bearer ${token}`,
          [PORT_CLIENT_HEADER]: first.credential,
        },
        body: JSON.stringify({
          status: 200,
          contentType: 'application/json',
          body: Buffer.from('{}').toString('base64'),
          request: { ...forward(h, b), body: null },
        }),
      });
    expect((await signFor(first.headers, first.body)).status).toBe(200);
    const b2 = send('m-n2-b');
    const h2 = signedHeaders(key, 'POST', `${RELAY}/a2a/v1/message:send`, b2);
    expect((await signFor(h2, b2)).status).toBe(403);
  });

  it('M1: unverifiable for a whole window marks the peer auth-failed; a probe brings it back unless a verified AUTH_* refusal', async () => {
    await handle.stop();
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      a2aUnverifiedWindowMs: 400,
    });
    useTestAuth(handle);
    base = `http://127.0.0.1:${handle.port}`;
    useSeedBase(base);
    const peerKey = newKey();
    // 'proxy' answers unsigned; 'ok' signs a 404; 'revoked' signs a 401.
    let mode: 'proxy' | 'ok' | 'revoked' = 'proxy';
    const peer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/.well-known/agent-card.json')
          return Response.json({
            name: 'Proxy-fronted peer',
            description: 'A fixture.',
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
        if (mode === 'proxy')
          return new Response('bad gateway', { status: 502 });
        const res =
          mode === 'ok'
            ? Response.json(
                {
                  error: {
                    code: 404,
                    status: 'NOT_FOUND',
                    message: 'no such task',
                  },
                },
                { status: 404 }
              )
            : Response.json(
                {
                  error: {
                    code: 401,
                    status: 'UNAUTHENTICATED',
                    message: 'revoked',
                    details: [
                      {
                        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                        reason: 'AUTH_AGENT_REVOKED',
                        domain: 'a2a-protocol.org',
                      },
                    ],
                  },
                },
                { status: 401 }
              );
        return signResponseFor(
          res,
          { method: req.method, targetUri: req.url, headers: req.headers },
          { keyid: peerKey.keyid, privateKey: peerKey.privateKey }
        );
      },
    });
    try {
      const origin = `http://127.0.0.1:${peer.port}`;
      const added = await fetch(`${base}/api/a2a/peers`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          alias: 'flaky',
          cardUrl: `${origin}/.well-known/agent-card.json`,
          token: 'unused',
        }),
      });
      expect(added.status).toBe(201);
      handle.a2a.store!.setPeerKey('flaky', {
        thumbprint: peerKey.keyid,
        jwk: peerKey.jwk,
        auth: 'signature',
        pairedId: null,
      });
      const sendOne = (body: string) =>
        handle.messaging.engine.send(
          { to: ['a2a:flaky'], kind: 'message', body },
          { address: 'human:test', canDecide: true }
        );
      const { message: one } = await sendOne('One.');
      await waitFor(
        () =>
          (handle.a2a.store!.getOutbound(one.id, 'flaky')?.attempts ?? 0) >= 1,
        10_000
      );
      // Inside the window: however many, still active.
      await sendOne('Two.');
      await new Promise((r) => setTimeout(r, 100));
      expect(handle.a2a.store!.getPeer('flaky')?.status).toBe('active');
      // Past it, the next unverifiable reply fails the peer.
      await new Promise((r) => setTimeout(r, 400));
      await sendOne('Three.');
      await waitFor(
        () => handle.a2a.store!.getPeer('flaky')?.status === 'auth-failed',
        10_000
      );
      // The proxy is fixed: the hourly probe sees a verified reply and re-enables.
      mode = 'ok';
      await handle.a2a.probeUnverified();
      expect(handle.a2a.store!.getPeer('flaky')?.status).toBe('active');
      // A verified AUTH_* refusal is sticky: the probe leaves it alone.
      mode = 'revoked';
      await sendOne('Four.');
      await waitFor(
        () => handle.a2a.store!.getPeer('flaky')?.status === 'auth-failed',
        10_000
      );
      mode = 'ok';
      await handle.a2a.probeUnverified();
      expect(handle.a2a.store!.getPeer('flaky')?.status).toBe('auth-failed');
    } finally {
      await peer.stop(true);
    }
  });
});
