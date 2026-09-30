import { describe, expect, it } from 'bun:test';

import { compressForNetwork } from '../src/compression.js';

// A JSON body past the size floor, and a request that accepts gzip.
const big = JSON.stringify(
  Array.from({ length: 2000 }, (_, i) => ({ id: `t-${i}`, title: 'x' }))
);
const json = { 'content-type': 'application/json; charset=utf-8' };
const accepting = (encoding = 'gzip, deflate, br') =>
  new Request('http://daemon/api/tasks', {
    headers: { 'accept-encoding': encoding },
  });

describe('compressForNetwork', () => {
  it('gzips a large JSON body for a peer on another machine', async () => {
    const res = await compressForNetwork(
      accepting(),
      new Response(big, {
        status: 201,
        headers: { ...json, 'set-cookie': 'a=b' },
      }),
      '192.168.1.20'
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('accept-encoding');
    expect(res.headers.get('set-cookie')).toBe('a=b');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(big.length / 4);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(big);
  });

  it('leaves loopback, unknown and non-accepting peers alone', async () => {
    for (const [req, peer] of [
      [accepting(), '127.0.0.1'],
      [accepting(), '::ffff:127.0.0.1'],
      [accepting(), '::1'],
      [accepting(), null],
      [new Request('http://daemon/api/tasks'), '10.0.0.2'],
      [accepting('gzip;q=0, br'), '10.0.0.2'],
    ] as const) {
      const res = await compressForNetwork(
        req,
        new Response(big, { headers: json }),
        peer
      );
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.text()).toBe(big);
    }
  });

  it('sends small and non-JSON bodies as they are', async () => {
    const small = await compressForNetwork(
      accepting('*'),
      new Response('{"ok":true}', { status: 404, headers: json }),
      '10.0.0.2'
    );
    expect(small.status).toBe(404);
    expect(small.headers.get('content-encoding')).toBeNull();
    expect(await small.text()).toBe('{"ok":true}');

    const blob = await compressForNetwork(
      accepting(),
      new Response(big, { headers: { 'content-type': 'text/plain' } }),
      '10.0.0.2'
    );
    expect(blob.headers.get('content-encoding')).toBeNull();
  });
});
