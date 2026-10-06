import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { PeerHttpError } from '../../src/peer/http.js';
import { signedFetch } from '../../src/sig/fetch.js';
import { ecThumbprint } from '../../src/sig/keys.js';
import { signResponse } from '../../src/sig/sign.js';
import { verifyRequest } from '../../src/sig/verify.js';

function key(): { privateKey: KeyObject; publicKey: KeyObject; keyid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    privateKey,
    publicKey,
    keyid: ecThumbprint(
      publicKey.export({ format: 'jwk' }) as Record<string, string>
    )!,
  };
}

const me = key();
const peer = key();
const impostor = key();
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  await server?.stop(true);
  server = null;
});

type Mode =
  | 'signed'
  | 'unsigned'
  | 'impostor'
  | 'tampered'
  | 'stream'
  | 'signed401';

// A peer that checks our signature, then answers signed by its own key.
function startPeer(mode: Mode): string {
  const seen: string[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
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
          keyFor: (id) => (id === me.keyid ? me.publicKey : null),
          now: new Date(),
          guardMs: 300_000,
          rememberNonce: (_id, nonce) =>
            seen.includes(nonce) ? 'replay' : (seen.push(nonce), 'fresh'),
        }
      );
      if (!ok.ok) return new Response(ok.reason, { status: 401 });
      const stream = mode === 'stream';
      const status = mode === 'signed401' ? 401 : 200;
      const payload = new TextEncoder().encode(
        stream ? 'data: {}\n\n' : '{"ok":true}'
      );
      const headers = new Headers({
        'content-type': stream ? 'text/event-stream' : 'application/json',
      });
      if (mode !== 'unsigned') {
        const signer = mode === 'impostor' ? impostor : peer;
        const out = signResponse({
          status,
          headers,
          body: stream ? null : payload,
          request: {
            method: req.method,
            targetUri: req.url,
            headers: req.headers,
          },
          keyid: signer.keyid,
          privateKey: signer.privateKey,
          now: new Date(),
        });
        for (const [k, v] of Object.entries(out)) headers.set(k, v);
      }
      const sent =
        mode === 'tampered'
          ? new TextEncoder().encode('{"ok":false}')
          : payload;
      return new Response(sent, { status, headers });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const client = () =>
  signedFetch(fetch, {
    keyid: me.keyid,
    privateKey: me.privateKey,
    peerKey: peer.publicKey,
  });

const post = (origin: string) =>
  client()(`${origin}/a2a/v1/message:send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ message: { messageId: 'm-1' } }),
  });

describe('signedFetch', () => {
  it('signs the request and accepts a response the pinned peer key signed', async () => {
    const res = await post(startPeer('signed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('signs a GET without a body', async () => {
    const origin = startPeer('signed');
    const res = await client()(`${origin}/a2a/v1/tasks/t-1?historyLength=2`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ['unsigned', 'sig_missing'],
    ['impostor', 'sig_key_unknown'],
    ['tampered', 'sig_digest'],
  ] as const)(
    'reads a %s reply as unverifiable: retryable like a network fault, never a 401',
    async (mode, reason) => {
      const box = {
        status: 200 as number | null,
        retryAfterSec: null,
        network: false,
        reason: null as string | null,
      };
      const f = signedFetch(fetch, {
        keyid: me.keyid,
        privateKey: me.privateKey,
        peerKey: peer.publicKey,
        box,
      });
      const err = await f(`${startPeer(mode)}/a2a/v1/message:send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PeerHttpError);
      expect(err).toMatchObject({ status: null, reason });
      expect(box).toMatchObject({ status: null, network: true, reason });
    }
  );

  it('reads an error the inner fetch threw with an unverified status as unverifiable (review N1/N7)', async () => {
    for (const thrown of [
      new PeerHttpError(302, 'a redirect was not followed'),
      new PeerHttpError(200, 'the body is over the cap'),
      new PeerHttpError(401, 'an unsigned 401 page'),
    ]) {
      const box = {
        status: 200 as number | null,
        retryAfterSec: null,
        network: false,
        reason: null as string | null,
      };
      const f = signedFetch(
        (() => Promise.reject(thrown)) as unknown as typeof fetch,
        {
          keyid: me.keyid,
          privateKey: me.privateKey,
          peerKey: peer.publicKey,
          box,
        }
      );
      const err = await f('https://peer.example.com/a2a/v1/tasks/x').catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(PeerHttpError);
      expect(err).toMatchObject({ status: null, reason: 'sig_missing' });
      expect(box).toMatchObject({ status: null, network: true });
    }
  });

  it('passes a verified 401 through, so the caller can read its AUTH_* reason', async () => {
    const res = await post(startPeer('signed401'));
    expect(res.status).toBe(401);
  });

  it('verifies an event stream by its headers and leaves the body to stream', async () => {
    const res = await post(startPeer('stream'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {}\n\n');
  });
});
