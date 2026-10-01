import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StatusBox } from '../../src/peer/http.js';
import {
  isLoopbackHost,
  peerFetch,
  PeerHttpError,
  readCapped,
} from '../../src/peer/http.js';

// A body that sends `count` chunks of `size` bytes, one every `everyMs`.
function dripping(
  size: number,
  everyMs: number,
  count: number,
  headers: Record<string, string> = {}
): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === count) return controller.close();
      await Bun.sleep(everyMs);
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(120));
    },
  });
  return new Response(body, { headers });
}

// A body of `count` chunks of `size` bytes, as fast as the reader takes them.
function chunked(count: number, size: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === count) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(120));
    },
  });
  return new Response(body);
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: { version: string | null; auth: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push({
        version: req.headers.get('A2A-Version'),
        auth: req.headers.get('authorization'),
      });
      if (path === '/redirect')
        return new Response(null, {
          status: Number(new URL(req.url).searchParams.get('status') ?? '302'),
          headers: { location: 'http://169.254.169.254/' },
        });
      if (path === '/limited')
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '120' },
        });
      if (path === '/slow') {
        await Bun.sleep(300);
        return new Response('late');
      }
      if (path === '/big') return new Response('x'.repeat(2048));
      if (path === '/not-modified') return new Response(null, { status: 304 });
      if (path === '/drip') return dripping(1, 100, 50);
      if (path === '/huge') return chunked(64, 1024 * 1024);
      if (path === '/sse')
        return dripping(
          1,
          Number(new URL(req.url).searchParams.get('every') ?? '50'),
          Number(new URL(req.url).searchParams.get('n') ?? '3'),
          { 'content-type': 'text/event-stream' }
        );
      return new Response('ok');
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const box = (): StatusBox => ({
  status: null,
  retryAfterSec: null,
  network: false,
});

describe('peerFetch', () => {
  it('sets its fixed headers over the caller’s', async () => {
    await peerFetch({
      headers: { 'A2A-Version': '1.0', authorization: 'Bearer peer' },
      timeoutMs: 1000,
    })(`${base}/ok`, { headers: { authorization: 'Bearer other' } });
    expect(seen.at(-1)).toEqual({ version: '1.0', auth: 'Bearer peer' });
  });

  it.each([301, 302, 303, 307, 308])(
    'never follows a %d redirect',
    async (status) => {
      await expect(
        peerFetch({ headers: {}, timeoutMs: 1000 })(
          `${base}/redirect?status=${status}`
        )
      ).rejects.toMatchObject({ status });
    }
  );

  it('keeps the deadline armed until the body is read', async () => {
    const b = box();
    const started = Date.now();
    const res = await peerFetch({ headers: {}, timeoutMs: 200, box: b })(
      `${base}/drip`
    );
    const err = await res.text().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
    expect(err).toMatchObject({ status: null });
    expect(b.network).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a body over the cap, 1 MiB unless told otherwise', async () => {
    const huge = await peerFetch({ headers: {}, timeoutMs: 5000 })(
      `${base}/huge`
    );
    await expect(huge.text()).rejects.toMatchObject({
      reason: 'BODY_TOO_LARGE',
    });
    const big = await peerFetch({
      headers: {},
      timeoutMs: 1000,
      maxBodyBytes: 1024,
    })(`${base}/big`);
    await expect(big.text()).rejects.toMatchObject({
      reason: 'BODY_TOO_LARGE',
    });
    const ok = await peerFetch({ headers: {}, timeoutMs: 1000 })(`${base}/big`);
    expect(await ok.text()).toHaveLength(2048);
  });

  it('lets an event stream outlive the deadline while it keeps sending', async () => {
    const res = await peerFetch({
      headers: {},
      timeoutMs: 100,
      idleMs: 300,
    })(`${base}/sse?n=6&every=50`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(await res.text()).toHaveLength(6);
  });

  it('ends an event stream that goes quiet past the idle timeout', async () => {
    const res = await peerFetch({
      headers: {},
      timeoutMs: 1000,
      idleMs: 100,
    })(`${base}/sse?n=3&every=400`, {
      headers: { accept: 'text/event-stream' },
    });
    await expect(res.text()).rejects.toMatchObject({ status: null });
  });

  it('fails a request header it cannot send without echoing the value', async () => {
    const err = await peerFetch({
      headers: { authorization: 'Bearer SECRET\nX: 1' },
      timeoutMs: 1000,
    })(`${base}/ok`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('hands a 304 back as a response, not a redirect', async () => {
    const res = await peerFetch({ headers: {}, timeoutMs: 1000 })(
      `${base}/not-modified`
    );
    expect(res.status).toBe(304);
  });

  it('records the status and Retry-After', async () => {
    const b = box();
    expect(
      (
        await peerFetch({ headers: {}, timeoutMs: 1000, box: b })(
          `${base}/limited`
        )
      ).status
    ).toBe(429);
    expect(b).toEqual({ status: 429, retryAfterSec: 120, network: false });
  });

  it('times out on the headers as a network failure (status null)', async () => {
    const b = box();
    const err = await peerFetch({ headers: {}, timeoutMs: 50, box: b })(
      `${base}/slow`
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
    expect(err).toMatchObject({ status: null });
    expect(b.network).toBe(true);
  });

  it.each(['file:///etc/passwd', 'data:text/plain,hi'])(
    'never fetches %s',
    async (url) => {
      let called = false;
      const err = await peerFetch({
        headers: {},
        timeoutMs: 1000,
        fetchImpl: (() => {
          called = true;
          return Promise.resolve(new Response(''));
        }) as unknown as typeof fetch,
      })(url).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PeerHttpError);
      expect(called).toBe(false);
    }
  );
});

// Records what the guarded fetch hands the network, without touching it.
function recorder(): {
  calls: { url: string; host: string | null; tls: unknown }[];
  fetchImpl: typeof fetch;
} {
  const calls: { url: string; host: string | null; tls: unknown }[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      host: new Headers(init?.headers).get('host'),
      tls: (init as { tls?: unknown } | undefined)?.tls,
    });
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('peerFetch with the public-address guard', () => {
  it('connects to the checked address, keeping the name for Host and TLS', async () => {
    const { calls, fetchImpl } = recorder();
    const get = peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      guard: { lookup: () => Promise.resolve(['93.184.216.34']) },
    });
    await get('https://agent.example.com:8443/a2a/v1/tasks?x=1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://93.184.216.34:8443/a2a/v1/tasks?x=1');
    expect(calls[0].host).toBe('agent.example.com:8443');
    expect(calls[0].tls).toMatchObject({ serverName: 'agent.example.com' });
  });

  it('tries the next checked address when a connect fails', async () => {
    const tried: string[] = [];
    const fetchImpl = ((input: string | URL) => {
      tried.push(String(input));
      return String(input).includes('93.184.216.34')
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;
    const res = await peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      guard: {
        lookup: () => Promise.resolve(['93.184.216.34', '2606:2800:220:1::1']),
      },
    })('https://agent.example.com/x', { method: 'POST', body: '{}' });
    expect(await res.text()).toBe('ok');
    expect(tried).toEqual([
      'https://93.184.216.34/x',
      'https://[2606:2800:220:1::1]/x',
    ]);
  });

  it('stops at the first address that answers, even with an error status', async () => {
    const tried: string[] = [];
    const fetchImpl = ((input: string | URL) => {
      tried.push(String(input));
      return Promise.resolve(new Response('no', { status: 503 }));
    }) as unknown as typeof fetch;
    const res = await peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      guard: {
        lookup: () => Promise.resolve(['93.184.216.34', '93.184.216.35']),
      },
    })('https://agent.example.com/x');
    expect(res.status).toBe(503);
    expect(tried).toHaveLength(1);
  });

  it('brackets a pinned IPv6 address', async () => {
    const { calls, fetchImpl } = recorder();
    await peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      guard: { lookup: () => Promise.resolve(['2606:2800:220:1::1']) },
    })('https://agent.example.com/card');
    expect(calls[0].url).toBe('https://[2606:2800:220:1::1]/card');
  });

  it('re-resolves before every request, so a rebind to a private address is refused', async () => {
    const { calls, fetchImpl } = recorder();
    const answers = [['93.184.216.34'], ['169.254.169.254']];
    const b = box();
    const get = peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      box: b,
      guard: { lookup: () => Promise.resolve(answers.shift() ?? []) },
    });
    await get('https://rebind.example.com/one');
    const err = await get('https://rebind.example.com/two').catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PeerHttpError);
    expect(err).toMatchObject({
      status: null,
      reason: 'ADDRESS_REFUSED',
      message: expect.stringContaining('link-local'),
    });
    expect(calls.map((c) => c.url)).toEqual(['https://93.184.216.34/one']);
  });

  it('reads a lookup failure as a retryable network error, not a refusal', async () => {
    const { calls, fetchImpl } = recorder();
    const b = box();
    const err = await peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      box: b,
      guard: { lookup: () => Promise.reject(new Error('EAI_AGAIN')) },
    })('https://offline.example.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
    expect(err).toMatchObject({ status: null, reason: null });
    expect(b.network).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses plain http and IP literals before any lookup', async () => {
    const { calls, fetchImpl } = recorder();
    let lookups = 0;
    const get = peerFetch({
      headers: {},
      timeoutMs: 1000,
      fetchImpl,
      guard: {
        lookup: () => {
          lookups++;
          return Promise.resolve(['93.184.216.34']);
        },
      },
    });
    for (const url of ['http://agent.example.com/', 'https://127.0.0.1/'])
      await expect(get(url)).rejects.toBeInstanceOf(PeerHttpError);
    expect(lookups).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('times out a lookup that hangs', async () => {
    const { fetchImpl } = recorder();
    const err = await peerFetch({
      headers: {},
      timeoutMs: 50,
      fetchImpl,
      guard: { lookup: () => new Promise<string[]>(() => undefined) },
    })('https://hang.example.com/').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: null });
  });
});

describe('a pinned TLS connection', () => {
  let dir: string;
  let tlsServer: ReturnType<typeof Bun.serve>;
  let certs: { good: string; other: string };

  // Two self-signed certificates: one for the peer's name, one for another name.
  async function makeCert(
    name: string
  ): Promise<{ cert: string; key: string }> {
    const cert = join(dir, `${name}.crt`);
    const key = join(dir, `${name}.key`);
    const proc = Bun.spawn(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    );
    expect(await proc.exited).toBe(0);
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dispatch-a2a-pin-'));
    const peer = await makeCert('peer.example.com');
    const other = await makeCert('default.example.com');
    certs = { good: peer.cert, other: other.cert };
    tlsServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: [
        { cert: other.cert, key: other.key },
        { cert: peer.cert, key: peer.key, serverName: 'peer.example.com' },
      ],
      fetch: (req) => new Response(`host=${req.headers.get('host')}`),
    });
  });
  afterAll(async () => {
    await tlsServer.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // Real fetch, with the public test address routed to the local server and its CA trusted.
  const loopbackFetch = ((input: string | URL, init?: RequestInit) => {
    const url = String(input).replace(
      '93.184.216.34:1',
      `127.0.0.1:${tlsServer.port}`
    );
    const tls = (init as { tls?: object } | undefined)?.tls;
    return fetch(url, {
      ...init,
      tls: { ...tls, ca: [certs.good, certs.other] },
    } as RequestInit);
  }) as unknown as typeof fetch;

  it('sends SNI for the name and verifies the certificate against it', async () => {
    const res = await peerFetch({
      headers: {},
      timeoutMs: 5000,
      fetchImpl: loopbackFetch,
      guard: { lookup: () => Promise.resolve(['93.184.216.34']) },
    })('https://peer.example.com:1/card');
    expect(await res.text()).toBe('host=peer.example.com:1');
  });

  it('refuses a certificate that does not name the peer', async () => {
    const err = await peerFetch({
      headers: {},
      timeoutMs: 5000,
      fetchImpl: loopbackFetch,
      guard: { lookup: () => Promise.resolve(['93.184.216.34']) },
    })('https://imposter.example.com:1/card').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
  });
});

describe('readCapped and isLoopbackHost', () => {
  it('refuses a body over the cap, naming the field', async () => {
    await expect(
      readCapped(await fetch(`${base}/big`), 1024, 'cardUrl')
    ).rejects.toMatchObject({ code: 'invalid', field: 'cardUrl' });
  });

  it('reads a body under the cap', async () => {
    expect(await readCapped(await fetch(`${base}/ok`), 1024, 'cardUrl')).toBe(
      'ok'
    );
  });

  it('knows loopback hosts', () => {
    expect(
      ['localhost', '127.0.0.1', '[::1]', '::1'].map(isLoopbackHost)
    ).toEqual([true, true, true, true]);
    expect(isLoopbackHost('agent.example.com')).toBe(false);
    expect(isLoopbackHost('127.255.0.9')).toBe(true);
    for (const host of [
      '127.0.0.1.attacker.example',
      '127.attacker.example',
      'localhost.attacker.example',
      'my-localhost',
      '[::2]',
    ])
      expect(isLoopbackHost(host)).toBe(false);
  });
});
