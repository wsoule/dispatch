import { ecThumbprint, PORT_CLIENT_HEADER, signRequest } from '@dispatch/a2a';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
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
