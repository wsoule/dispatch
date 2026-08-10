import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDemoServer } from '../src/server.js';
import {
  type Session,
  SessionCapError,
  type SessionManager,
} from '../src/sessions.js';

// The four SessionManager methods the routes touch, stubbed so no test ever
// seeds a repo or spawns a daemon.
type ManagerStub = Partial<
  Pick<SessionManager, 'create' | 'get' | 'touch' | 'destroy'>
>;

function stubManager(overrides: ManagerStub = {}): SessionManager {
  return {
    create: () => Promise.reject(new SessionCapError()),
    get: () => undefined,
    touch: () => {},
    destroy: () => Promise.resolve(),
    ...overrides,
  } as unknown as SessionManager;
}

const ID = 'a'.repeat(16);

function fakeSession(port: number, id = ID): Session {
  return {
    id,
    port,
    agentToken: 'agent-tok',
    appToken: 'app-tok',
    paths: { root: '/sandbox/storefront' },
  } as unknown as Session;
}

// Bun.serve({ port: 0 }) always binds a TCP port; the type keeps it optional
// for unix-socket servers, which this never is.
function origin(server: { port?: number }): string {
  if (server.port === undefined) throw new Error('server did not bind a port');
  return `http://127.0.0.1:${server.port}`;
}

// Writes the smallest dist a served session page needs: an index.html with a
// </head> for injectDemoHtml plus one asset, so static serving is covered too.
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'demo-dist-'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><title>Dispatch</title></head><body></body></html>'
  );
  writeFileSync(join(dir, 'favicon.svg'), '<svg></svg>');
  return dir;
}

async function withServer(
  manager: SessionManager,
  distDir: string,
  run: (base: string) => Promise<void>
): Promise<void> {
  const server = createDemoServer({ manager, distDir, port: 0 });
  try {
    await run(origin(server));
  } finally {
    // Never awaited: Bun 1.3's stop(true) does not resolve once the server has
    // served a WebSocket, so awaiting it hangs the ws tests below.
    void server.stop(true);
  }
}

describe('demo server routes', () => {
  test('busy manager -> 503 busy on POST /session', async () => {
    await withServer(stubManager(), '/nonexistent', async (base) => {
      const res = await fetch(`${base}/session`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('busy');
    });
  });

  test('a create failure that is not the cap is a 500, not "busy"', async () => {
    const manager = stubManager({
      create: () => Promise.reject(new Error('seed exploded')),
    });
    await withServer(manager, '/nonexistent', async (base) => {
      const res = await fetch(`${base}/session`, { method: 'POST' });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe(
        'start-failed'
      );
    });
  });

  test('POST /session -> 201 with the new id', async () => {
    const manager = stubManager({
      create: () => Promise.resolve(fakeSession(1234)),
    });
    await withServer(manager, '/nonexistent', async (base) => {
      const res = await fetch(`${base}/session`, { method: 'POST' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: ID });
    });
  });

  test('unknown session api -> 404 session-expired', async () => {
    await withServer(stubManager(), '/nonexistent', async (base) => {
      const res = await fetch(`${base}/s/${ID}/api/tasks`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe(
        'session-expired'
      );
    });
  });

  test('unknown session page -> 404 serving the landing page', async () => {
    await withServer(stubManager(), '/nonexistent', async (base) => {
      const res = await fetch(`${base}/s/${ID}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('Launch the live demo');
    });
  });

  test('alive follows session existence without counting as activity', async () => {
    const touched: string[] = [];
    const manager = stubManager({
      get: (id: string) => (id === ID ? fakeSession(1234) : undefined),
      touch: (id: string) => {
        touched.push(id);
      },
    });
    await withServer(manager, '/nonexistent', async (base) => {
      expect((await fetch(`${base}/s/${ID}/alive`)).status).toBe(200);
      expect((await fetch(`${base}/s/${'b'.repeat(16)}/alive`)).status).toBe(
        404
      );
      // The overlay polls this every 30s; touching here would make an
      // abandoned tab immortal and hold a cap slot forever.
      expect(touched).toEqual([]);
    });
  });

  test('session page injects the config, no-store, and honors ?embed=1', async () => {
    const distDir = fakeDist();
    const manager = stubManager({
      get: (id: string) => (id === ID ? fakeSession(1234) : undefined),
    });
    await withServer(manager, distDir, async (base) => {
      const plain = await fetch(`${base}/s/${ID}/`);
      expect(plain.status).toBe(200);
      expect(plain.headers.get('cache-control')).toBe('no-store');
      const html = await plain.text();
      expect(html).toContain('window.__DISPATCH_DEMO__');
      expect(html).toContain(`/s/${ID}"`); // absolute baseUrl, no trailing slash
      expect(html).toContain('agent-tok');
      expect(html).toContain('demo-banner');

      const embedded = await fetch(`${base}/s/${ID}/?embed=1`);
      expect(await embedded.text()).not.toContain('demo-banner');
    });
  });

  test('a dead daemon expires the session instead of 502-ing', async () => {
    const destroyed: string[] = [];
    let alive = true;
    const manager = stubManager({
      // Port 1 refuses connections, so proxyHttp rejects the way it does when
      // a daemon has crashed out from under a live session record.
      get: (id: string) => (alive && id === ID ? fakeSession(1) : undefined),
      destroy: (id: string) => {
        destroyed.push(id);
        alive = false;
        return Promise.resolve();
      },
    });
    await withServer(manager, '/nonexistent', async (base) => {
      const res = await fetch(`${base}/s/${ID}/api/tasks`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe(
        'session-expired'
      );
      expect(destroyed).toEqual([ID]);
    });
  });

  test('api requests touch the session and reach the daemon', async () => {
    const touched: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => new Response(new URL(req.url).pathname),
    });
    const manager = stubManager({
      get: (id: string) =>
        id === ID ? fakeSession(upstream.port as number) : undefined,
      touch: (id: string) => {
        touched.push(id);
      },
    });
    try {
      await withServer(manager, '/nonexistent', async (base) => {
        const res = await fetch(`${base}/s/${ID}/api/tasks?x=1`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('/api/tasks');
        expect(touched).toEqual([ID]);
      });
    } finally {
      void upstream.stop(true);
    }
  });

  test('static assets come from distDir and stay inside it', async () => {
    const distDir = fakeDist();
    await withServer(stubManager(), distDir, async (base) => {
      const asset = await fetch(`${base}/favicon.svg`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('no-cache');

      const escape = await fetch(`${base}/../../etc/hosts`);
      expect(escape.status).toBe(404);
    });
  });

  test('the overlay script is served for the injected tag', async () => {
    await withServer(stubManager(), '/nonexistent', async (base) => {
      const res = await fetch(`${base}/demo-overlay.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('/alive');
    });
  });

  test('ws upgrades bridge to the daemon, token and closes included', async () => {
    const seenTokens: (string | null)[] = [];
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        seenTokens.push(new URL(req.url).searchParams.get('token'));
        return server.upgrade(req)
          ? undefined
          : new Response('no upgrade', { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.send('hello-from-daemon');
        },
        message: () => {},
        close: () => upstreamClosed.resolve(),
      },
    });
    const manager = stubManager({
      get: (id: string) =>
        id === ID ? fakeSession(upstream.port as number) : undefined,
    });
    try {
      await withServer(manager, '/nonexistent', async (base) => {
        const received = Promise.withResolvers<string>();
        const client = new WebSocket(
          `${base.replace('http', 'ws')}/s/${ID}/ws?token=app-tok`
        );
        client.onmessage = (event) => received.resolve(event.data as string);
        expect(await received.promise).toBe('hello-from-daemon');
        expect(seenTokens).toEqual(['app-tok']);

        // Closing the browser side must not leave the daemon's socket open.
        client.close();
        await upstreamClosed.promise;
      });
    } finally {
      void upstream.stop(true);
    }
  });

  test('the daemon dropping its socket closes the browser socket too', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: (req, server) =>
        server.upgrade(req) ? undefined : new Response('no', { status: 400 }),
      websocket: {
        open: (ws) => ws.close(),
        message: () => {},
      },
    });
    const manager = stubManager({
      get: (id: string) =>
        id === ID ? fakeSession(upstream.port as number) : undefined,
    });
    try {
      await withServer(manager, '/nonexistent', async (base) => {
        const closed = Promise.withResolvers<void>();
        const client = new WebSocket(
          `${base.replace('http', 'ws')}/s/${ID}/ws?token=t`
        );
        client.onclose = () => closed.resolve();
        await closed.promise;
      });
    } finally {
      void upstream.stop(true);
    }
  });

  test('ws for an unknown session is a 404, not an upgrade', async () => {
    await withServer(stubManager(), '/nonexistent', async (base) => {
      const res = await fetch(`${base}/s/${ID}/ws`);
      expect(res.status).toBe(404);
    });
  });

  test('an unknown suffix under /s/ never falls through to static', async () => {
    const distDir = fakeDist();
    await withServer(stubManager(), distDir, async (base) => {
      const res = await fetch(`${base}/s/${ID}/favicon.svg`);
      expect(res.status).toBe(404);
    });
  });
});
