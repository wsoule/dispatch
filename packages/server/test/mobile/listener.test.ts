import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deviceMayReach } from '../../src/mobile/allowlist.js';
import type { MobileListenerDeps } from '../../src/mobile/listener.js';
import { serveMobile } from '../../src/mobile/listener.js';

const DEVICE_TOKEN = 'device-token';

let dist: string;
let forwarded: Request[];

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'dispatch-mobile-dist-'));
  mkdirSync(join(dist, 'm'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'm', 'index.html'), '<html><head></head>app</html>');
  writeFileSync(
    join(dist, 'm', 'sw.js'),
    'self.addEventListener("push",()=>{})'
  );
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'export {}');
  // The desktop app's own entry sits beside m/ and must never be served here.
  writeFileSync(join(dist, 'index.html'), '<html>desktop</html>');
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

function deps(over: Partial<MobileListenerDeps> = {}): MobileListenerDeps {
  forwarded = [];
  return {
    handleApi: (req) => {
      forwarded.push(req);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': 'https://evil.test',
          },
        })
      );
    },
    isDeviceToken: (token) => token === DEVICE_TOKEN,
    distDir: dist,
    ...over,
  };
}

const at = (path: string, init?: RequestInit) =>
  new Request(`https://laptop.tailnet.ts.net${path}`, init);

describe('the mobile app', () => {
  test('serves /m/ with no credential injected', async () => {
    const res = await serveMobile(at('/m/'), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe('<html><head></head>app</html>');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('falls back to the app for client-side routes', async () => {
    const res = await serveMobile(at('/m/runs'), deps());
    expect(await res.text()).toContain('app');
  });

  test('scopes the service worker to /m/', async () => {
    const res = await serveMobile(at('/m/sw.js'), deps());
    expect(res.headers.get('service-worker-allowed')).toBe('/m/');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  test('serves shared hashed chunks as immutable', async () => {
    const res = await serveMobile(at('/assets/app-abc.js'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  test('never serves the desktop entry or anything outside m/ and assets/', async () => {
    expect((await serveMobile(at('/index.html'), deps())).status).toBe(404);
    expect(
      (
        await serveMobile(
          at(`/assets/..${encodeURIComponent('/')}index.html`),
          deps()
        )
      ).status
    ).toBe(404);
  });

  test('a malformed escape is the app, not a crash', async () => {
    const res = await serveMobile(at('/m/%E0%A4%A'), deps());
    expect(await res.text()).toContain('app');
  });

  test('redirects the bare root to the app', async () => {
    const res = await serveMobile(at('/'), deps());
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/m/');
  });
});

describe('the API through the mobile listener', () => {
  test('refuses a request with no device token, before handleApi', async () => {
    const d = deps();
    const res = await serveMobile(at('/api/decisions/open'), d);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  test('refuses a token that is not a paired device, even the app token from loopback', async () => {
    const d = deps();
    const res = await serveMobile(
      new Request('http://127.0.0.1:4800/api/decisions/open', {
        headers: { authorization: 'Bearer the-app-token' },
      }),
      d
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  test('refuses a device on a route outside the allowlist', async () => {
    const d = deps();
    const res = await serveMobile(
      at('/api/tasks', {
        headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      }),
      d
    );
    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test('forwards an allowlisted call with only the bearer, type and body', async () => {
    const d = deps();
    const res = await serveMobile(
      at('/api/messages/m-1/reply?x=1', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${DEVICE_TOKEN}`,
          'content-type': 'application/json',
          origin: 'https://laptop.tailnet.ts.net',
          cookie: 'dispatch_session=stolen',
        },
        body: JSON.stringify({ body: 'yes', choice: 'approve' }),
      }),
      d
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    const req = forwarded[0];
    expect(new URL(req.url).pathname).toBe('/api/messages/m-1/reply');
    expect(new URL(req.url).search).toBe('?x=1');
    expect(req.headers.get('authorization')).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(req.headers.get('origin')).toBeNull();
    expect(req.headers.get('cookie')).toBeNull();
    expect(await req.json()).toEqual({ body: 'yes', choice: 'approve' });
    // Nothing the router said about CORS survives onto the tunnel.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('forwards pairing with no credential at all', async () => {
    const d = deps();
    const res = await serveMobile(
      at('/api/pair', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer something-else',
        },
        body: JSON.stringify({ code: 'ABCD-EFGH', name: 'Phone' }),
      }),
      d
    );
    expect(res.status).toBe(200);
    expect(forwarded[0].headers.get('authorization')).toBeNull();
  });
});

describe('deviceMayReach', () => {
  test('lets a phone see and answer what is waiting', () => {
    expect(deviceMayReach('GET', ['decisions', 'open'])).toBe(true);
    expect(deviceMayReach('POST', ['messages', 'm-1', 'reply'])).toBe(true);
    expect(deviceMayReach('GET', ['runs'])).toBe(true);
  });

  test('keeps a phone off everything that acts on the project', () => {
    expect(deviceMayReach('POST', ['runs'])).toBe(false);
    expect(deviceMayReach('GET', ['runs', 'r-1'])).toBe(false);
    expect(deviceMayReach('POST', ['runs', 'r-1', 'review'])).toBe(false);
    expect(deviceMayReach('GET', ['tasks'])).toBe(false);
    expect(deviceMayReach('POST', ['pair', 'offer'])).toBe(false);
    expect(deviceMayReach('PUT', ['mobile', 'settings'])).toBe(false);
    expect(deviceMayReach('DELETE', ['devices', 'd-1'])).toBe(false);
  });
});
