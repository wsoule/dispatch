import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  authHeaders,
  checkPeerCard,
  fetchPeerCard,
  peerAuthFor,
  pickInterface,
  summarizeCard,
} from '../../src/peer/card.js';
import { PeerHttpError } from '../../src/peer/http.js';

const CARD = {
  name: 'Acme Planner',
  description: 'Plans things.',
  version: '1',
  supportedInterfaces: [
    {
      url: 'https://acme.example.com/grpc',
      protocolBinding: 'GRPC',
      protocolVersion: '1.0',
    },
    {
      url: 'https://acme.example.com/v03',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '0.3',
    },
    {
      url: 'https://acme.example.com/a2a/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    },
  ],
  capabilities: { streaming: true },
  securitySchemes: {
    bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  skills: [
    { id: 'plan', name: 'Plan', description: 'Makes a plan.', tags: [] },
  ],
};
const CARD_URL = 'https://acme.example.com/.well-known/agent-card.json';

// A card whose one interface is `url` in `binding`.
const withInterface = (url: string, binding = 'JSONRPC') => ({
  ...CARD,
  supportedInterfaces: [
    { url, protocolBinding: binding, protocolVersion: '1.0' },
  ],
});

describe('reading a peer card', () => {
  it('picks the first A2A 1.0 HTTP+JSON or JSON-RPC interface', () => {
    expect(pickInterface(CARD)).toEqual({
      url: 'https://acme.example.com/a2a/v1',
      binding: 'HTTP+JSON',
    });
    expect(
      pickInterface({
        ...CARD,
        supportedInterfaces: [CARD.supportedInterfaces[0]],
      })
    ).toBeNull();
    expect(pickInterface({ ...CARD, supportedInterfaces: 'x' })).toBeNull();
  });

  it('reads bearer, header API key, and no auth', () => {
    expect(peerAuthFor(CARD)).toEqual({ kind: 'bearer' });
    const apiKey = {
      ...CARD,
      securitySchemes: {
        k: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } },
      },
      securityRequirements: [{ schemes: { k: { list: [] } } }],
    };
    expect(peerAuthFor(apiKey)).toEqual({
      kind: 'api-key',
      header: 'X-API-Key',
    });
    expect(peerAuthFor(apiKey, 'X-Other')).toEqual({
      kind: 'api-key',
      header: 'X-Other',
    });
    expect(peerAuthFor({ ...CARD, securityRequirements: [] })).toEqual({
      kind: 'none',
    });
  });

  it('refuses a card only OAuth2, OpenID Connect or mTLS would satisfy', () => {
    const oauth = {
      ...CARD,
      securitySchemes: { o: { oauth2SecurityScheme: { flows: {} } } },
      securityRequirements: [{ schemes: { o: { list: [] } } }],
    };
    expect(() => peerAuthFor(oauth)).toThrow(
      expect.objectContaining({ code: 'invalid', field: 'cardUrl' })
    );
  });

  it('pins the interface to the card’s origin unless allowOrigin confirms it', () => {
    const elsewhere = withInterface('https://internal.acme.example.com/a2a/v1');
    expect(() =>
      checkPeerCard({ cardUrl: CARD_URL, card: elsewhere, allowOrigin: false })
    ).toThrow(expect.objectContaining({ field: 'allowOrigin' }));
    expect(
      checkPeerCard({ cardUrl: CARD_URL, card: elsewhere, allowOrigin: true })
        .iface.binding
    ).toBe('JSONRPC');
  });

  it.each([
    'file:///etc/passwd',
    'http://169.254.169.254/latest',
    'https://user:pw@acme.example.com/a2a/v1',
    'not a url',
  ])('refuses an interface at %s even when the origin is confirmed', (url) => {
    expect(() =>
      checkPeerCard({
        cardUrl: CARD_URL,
        card: withInterface(url),
        allowOrigin: true,
      })
    ).toThrow(expect.objectContaining({ code: 'invalid', field: 'cardUrl' }));
  });

  it('allows an http interface on loopback or with allowHttp', () => {
    const local = 'http://127.0.0.1:9999/.well-known/agent-card.json';
    expect(
      checkPeerCard({
        cardUrl: local,
        card: withInterface('http://127.0.0.1:9999/a2a'),
        allowOrigin: false,
      }).iface.url
    ).toBe('http://127.0.0.1:9999/a2a');
    const lan = 'http://agent.lan/.well-known/agent-card.json';
    expect(() =>
      checkPeerCard({
        cardUrl: lan,
        card: withInterface('http://agent.lan/a2a'),
        allowOrigin: false,
      })
    ).toThrow(expect.objectContaining({ field: 'cardUrl' }));
    expect(
      checkPeerCard({
        cardUrl: lan,
        card: withInterface('http://agent.lan/a2a'),
        allowOrigin: false,
        allowHttp: true,
      }).iface.url
    ).toBe('http://agent.lan/a2a');
  });

  it('builds the auth header and needs a secret when the card asks for one', () => {
    expect(
      authHeaders({ kind: 'bearer' }, { scheme: 'bearer', token: 't' })
    ).toEqual({ authorization: 'Bearer t' });
    expect(
      authHeaders(
        { kind: 'api-key', header: 'X-API-Key' },
        { scheme: 'api-key', token: 'k' }
      )
    ).toEqual({ 'X-API-Key': 'k' });
    expect(authHeaders({ kind: 'none' }, null)).toEqual({});
    expect(() => authHeaders({ kind: 'bearer' }, null)).toThrow(
      expect.objectContaining({ field: 'token' })
    );
  });

  it.each([
    [
      { kind: 'bearer' } as const,
      { scheme: 'bearer', token: 'a\r\nX-Evil: 1' } as const,
    ],
    [
      { kind: 'api-key', header: 'Bad Header' } as const,
      { scheme: 'api-key', token: 'k' } as const,
    ],
    [
      { kind: 'api-key', header: 'Host' } as const,
      { scheme: 'api-key', token: 'evil.example.com' } as const,
    ],
  ])(
    'refuses a header that cannot or must not be sent (%j)',
    (auth, secret) => {
      expect(() => authHeaders(auth, secret)).toThrow(
        expect.objectContaining({ code: 'invalid', field: 'token' })
      );
    }
  );

  it.each([
    'SECRET with space',
    'SECRET\twith-tab',
    'SECRET-é',
    'SECRET\u007f',
    'SECRET\u0000',
    'SECRET\r\n',
  ])(
    'refuses a token outside visible ASCII, never echoing it (%j)',
    (token) => {
      for (const auth of [
        { kind: 'bearer' } as const,
        { kind: 'api-key', header: 'X-API-Key' } as const,
      ]) {
        let message = '';
        try {
          authHeaders(auth, { scheme: auth.kind, token });
        } catch (err) {
          expect(err).toMatchObject({ code: 'invalid', field: 'token' });
          message = (err as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain('SECRET');
      }
    }
  );

  it('summarizes name, description, skills and streaming', () => {
    expect(summarizeCard(CARD)).toEqual({
      name: 'Acme Planner',
      description: 'Plans things.',
      skills: [{ id: 'plan', name: 'Plan', description: 'Makes a plan.' }],
      streaming: true,
    });
  });
});

describe('fetchPeerCard', () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/card') {
          if (req.headers.get('if-none-match') === '"v1"')
            return new Response(null, { status: 304 });
          return Response.json(CARD, { headers: { etag: '"v1"' } });
        }
        if (path === '/moved')
          return new Response(null, {
            status: 302,
            headers: { location: '/card' },
          });
        if (path === '/huge')
          return new Response(
            JSON.stringify({ ...CARD, description: 'x'.repeat(300 * 1024) })
          );
        if (path === '/list') return Response.json([CARD]);
        if (path === '/hang') return new Promise<Response>(() => undefined);
        if (path === '/drip') {
          let sent = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (sent === 100) return controller.close();
                await Bun.sleep(100);
                sent += 1;
                controller.enqueue(
                  new TextEncoder().encode(sent === 1 ? '{' : ' ')
                );
              },
            })
          );
        }
        return new Response('nope', { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  it('fetches over loopback http, with its ETag, and honours If-None-Match', async () => {
    const first = await fetchPeerCard(`${base}/card`, { allowHttp: false });
    expect(first).toMatchObject({
      etag: '"v1"',
      notModified: false,
      json: { name: 'Acme Planner' },
    });
    expect(
      await fetchPeerCard(`${base}/card`, { allowHttp: false, etag: '"v1"' })
    ).toMatchObject({ notModified: true });
  });

  it('never follows a redirect, caps the card at 256 KiB and times out', async () => {
    await expect(
      fetchPeerCard(`${base}/moved`, { allowHttp: false })
    ).rejects.toMatchObject({ status: 302 });
    await expect(
      fetchPeerCard(`${base}/huge`, { allowHttp: false })
    ).rejects.toMatchObject({ code: 'invalid', field: 'cardUrl' });
    await expect(
      fetchPeerCard(`${base}/hang`, { allowHttp: false, timeoutMs: 50 })
    ).rejects.toBeInstanceOf(PeerHttpError);
  });

  it('times out a card that drips in slower than the deadline', async () => {
    const started = Date.now();
    await expect(
      fetchPeerCard(`${base}/drip`, { allowHttp: false, timeoutMs: 300 })
    ).rejects.toBeInstanceOf(PeerHttpError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a card that is not a JSON object, and a 404', async () => {
    await expect(
      fetchPeerCard(`${base}/list`, { allowHttp: false })
    ).rejects.toMatchObject({ field: 'cardUrl' });
    await expect(
      fetchPeerCard(`${base}/missing`, { allowHttp: false })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses http off loopback unless allowHttp', async () => {
    await expect(
      fetchPeerCard('http://agent.example.com/card', { allowHttp: false })
    ).rejects.toMatchObject({ field: 'cardUrl' });
  });

  it('refuses a guarded card URL that resolves to a private address, before fetching', async () => {
    let fetched = false;
    await expect(
      fetchPeerCard('https://agent.example.com/card', {
        allowHttp: false,
        guard: { lookup: () => Promise.resolve(['10.0.0.8']) },
        fetchImpl: (() => {
          fetched = true;
          return Promise.resolve(Response.json(CARD));
        }) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'invalid',
      field: 'cardUrl',
      message: expect.stringContaining('private'),
    });
    expect(fetched).toBe(false);
  });
});
