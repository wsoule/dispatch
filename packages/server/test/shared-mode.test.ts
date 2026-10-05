import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// Team-local mode end to end. The rules loopback made safe — an agent token
// injected into the served page, every loopback origin trusted, previews with
// no credential — are exactly the ones that must not survive a bind anyone on
// the network can reach. These tests reach the daemon over a real
// non-loopback interface where the machine has one, so "a teammate's browser"
// is an actual peer address, not a pretend one.

const LAN_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((a) => a !== undefined && !a.internal && a.family === 'IPv4')?.address;

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-shared-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'wyat@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Wyat']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

// A stand-in for the built desktop bundle: just enough for serveStatic.
function webDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-web-dist-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><title>Dispatch</title></head><body></body></html>'
  );
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

async function boot(host: string | undefined): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: webDist(),
    ...(host === undefined ? {} : { host }),
  });
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('loopback mode (the default) is unchanged', () => {
  it('still hands the served page its agent token', async () => {
    await boot(undefined);
    const html = await (
      await rawFetch(`http://127.0.0.1:${handle.port}/`)
    ).text();
    expect(html).toContain('__DISPATCH_DAEMON_TOKEN__');
    expect(html).toContain(handle.tokens.agentToken);
    expect(html).not.toContain('__DISPATCH_SHARED__');
  });
});

describe('team-local mode', () => {
  it('refuses a single interface address rather than losing loopback', async () => {
    await boot(undefined); // so afterEach has something to stop
    await expect(
      startServer({
        rootDir: root,
        port: 0,
        webDistDir: null,
        host: '192.168.1.5',
      })
    ).rejects.toThrow('0.0.0.0');
  });

  it('never injects a token into the page anyone on the network can load', async () => {
    await boot('0.0.0.0');
    const html = await (
      await rawFetch(`http://127.0.0.1:${handle.port}/`)
    ).text();

    // The whole point: injecting the operator's credential here would hand it
    // to every machine that can reach the port.
    expect(html).not.toContain(handle.tokens.agentToken);
    expect(html).not.toContain(handle.tokens.appToken);
    expect(html).not.toContain('__DISPATCH_DAEMON_TOKEN__');
    expect(html).toContain('__DISPATCH_SHARED__');
  });

  it('still answers the CLI and the app on loopback', async () => {
    await boot('0.0.0.0');
    const res = await rawFetch(`http://127.0.0.1:${handle.port}/api/whoami`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(res.status).toBe(200);
  });

  it.skipIf(LAN_ADDRESS === undefined)(
    "trusts a teammate's page on the daemon's own origin",
    async () => {
      await boot('0.0.0.0');
      const origin = `http://${LAN_ADDRESS}:${handle.port}`;
      // A state change from the daemon's own network origin — what a
      // teammate's browser sends — passes the origin guard and reaches auth.
      const res = await rawFetch(`${origin}/api/tasks`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          authorization: `Bearer ${handle.tokens.agentToken}`,
        },
        body: JSON.stringify({ title: 'From a teammate' }),
      });
      expect(res.status).toBe(201);
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'still rejects every other origin, however the Host header reads',
    async () => {
      await boot('0.0.0.0');
      // A DNS-rebinding page has an Origin and a Host that agree by
      // construction; agreeing with itself must not make it trusted.
      const res = await rawFetch(
        `http://${LAN_ADDRESS}:${handle.port}/api/tasks`,
        {
          method: 'POST',
          headers: {
            origin: `http://evil.example:${handle.port}`,
            host: `evil.example:${handle.port}`,
            'content-type': 'application/json',
            authorization: `Bearer ${handle.tokens.agentToken}`,
          },
          body: JSON.stringify({ title: 'Rebound' }),
        }
      );
      expect(res.status).toBe(403);
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'serves previews only to the machine running the daemon',
    async () => {
      await boot('0.0.0.0');
      const fromLan = await rawFetch(
        `http://${LAN_ADDRESS}:${handle.port}/preview/r-any/`
      );
      expect(fromLan.status).toBe(403);

      // Loopback still reaches the proxy, which 404s a run with no preview.
      const fromHere = await rawFetch(
        `http://127.0.0.1:${handle.port}/preview/r-any/`
      );
      expect(fromHere.status).toBe(404);
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'a teammate with an issued token is who they say, over the network',
    async () => {
      await boot('0.0.0.0');
      const issued = await rawFetch(
        `http://127.0.0.1:${handle.port}/api/team/tokens`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.tokens.appToken}`,
          },
          body: JSON.stringify({ email: 'ada@example.com' }),
        }
      );
      const { token } = (await issued.json()) as { token: string };

      const me = await rawFetch(
        `http://${LAN_ADDRESS}:${handle.port}/api/whoami`,
        {
          headers: { authorization: `Bearer ${token}` },
        }
      );
      expect(((await me.json()) as { handle: string }).handle).toBe('ada');
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'gzips a large list for a teammate, never for this machine',
    async () => {
      const store = new TaskStore(root);
      for (let i = 0; i < 120; i++) store.create({ title: `Task ${i}` });
      await boot('0.0.0.0');
      const read = (host: string) =>
        rawFetch(`http://${host}:${handle.port}/api/tasks?fields=meta`, {
          headers: {
            'accept-encoding': 'gzip',
            authorization: `Bearer ${handle.tokens.agentToken}`,
          },
          decompress: false,
        });

      const local = await read('127.0.0.1');
      expect(local.headers.get('content-encoding')).toBeNull();
      const plain = await local.text();
      expect(plain.length).toBeGreaterThan(32 * 1024);

      const remote = await read(LAN_ADDRESS ?? '');
      expect(remote.headers.get('content-encoding')).toBe('gzip');
      const bytes = new Uint8Array(await remote.arrayBuffer());
      expect(bytes.byteLength).toBeLessThan(plain.length / 4);
      expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(plain);
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'keeps both Vary keys on a gzipped reply to a trusted origin',
    async () => {
      const store = new TaskStore(root);
      for (let i = 0; i < 120; i++) store.create({ title: `Task ${i}` });
      await boot('0.0.0.0');
      const own = `http://${LAN_ADDRESS ?? ''}:${handle.port}`;
      const res = await rawFetch(`${own}/api/tasks?fields=meta`, {
        headers: {
          origin: own,
          'accept-encoding': 'gzip',
          authorization: `Bearer ${handle.tokens.agentToken}`,
        },
        decompress: false,
      });
      await res.arrayBuffer();

      expect(res.headers.get('content-encoding')).toBe('gzip');
      expect(res.headers.get('access-control-allow-origin')).toBe(own);
      const vary = (res.headers.get('vary') ?? '')
        .split(',')
        .map((key) => key.trim().toLowerCase());
      expect(vary).toContain('accept-encoding');
      expect(vary).toContain('origin');
    }
  );

  it.skipIf(LAN_ADDRESS === undefined)(
    'a teammate’s session cookie opens the event socket from the daemon’s own page',
    async () => {
      await boot('0.0.0.0');
      const origin = `http://${LAN_ADDRESS}:${handle.port}`;
      const issued = await rawFetch(
        `http://127.0.0.1:${handle.port}/api/team/tokens`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${handle.tokens.appToken}`,
          },
          body: JSON.stringify({ email: 'ada@example.com' }),
        }
      );
      const { token } = (await issued.json()) as { token: string };
      const signedIn = await rawFetch(`${origin}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ token }),
      });
      const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0];

      // No token in the URL: the upgrade is authenticated by the cookie alone,
      // as a browser tab on the daemon's page would send it.
      const opened = (from: string) =>
        new Promise<'open' | 'refused'>((resolve) => {
          const ws = new WebSocket(`ws://${LAN_ADDRESS}:${handle.port}/ws`, {
            headers: { cookie, origin: from },
          } as unknown as string[]);
          ws.onopen = () => {
            ws.close();
            resolve('open');
          };
          ws.onerror = () => resolve('refused');
        });
      expect(await opened(origin)).toBe('open');
      // The same cookie from a local dev server's page is not the teammate.
      expect(await opened(`http://127.0.0.1:5173`)).toBe('refused');
    }
  );

  describe('over HTTPS', () => {
    // A throwaway self-signed certificate, made fresh so no key lives in the
    // repo. The SAN names the LAN address, as a real deployment's would.
    function makeCert(): { certPath: string; keyPath: string } {
      const dir = mkdtempSync(join(tmpdir(), 'dispatch-tls-'));
      const certPath = join(dir, 'cert.pem');
      const keyPath = join(dir, 'key.pem');
      const res = spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=dispatch.test',
        '-addext',
        `subjectAltName=IP:127.0.0.1${LAN_ADDRESS === undefined ? '' : `,IP:${LAN_ADDRESS}`}`,
      ]);
      if (res.status !== 0)
        throw new Error(`openssl failed: ${String(res.stderr)}`);
      return { certPath, keyPath };
    }
    const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
    // The HTTPS listener binds 0.0.0.0, so it is one socket whether reached at
    // the LAN address or at loopback. These tests speak TLS to it over
    // loopback because some sandboxes route https to any other address
    // through a proxy; the Origin they send is still the LAN one a
    // teammate's browser would.

    it('refuses TLS without a network bind, since it would protect nothing', async () => {
      await boot(undefined);
      await expect(
        startServer({
          rootDir: root,
          port: 0,
          webDistDir: null,
          tls: makeCert(),
        })
      ).rejects.toThrow('--host 0.0.0.0');
    });

    it.skipIf(LAN_ADDRESS === undefined)(
      'teammates get HTTPS, and the plain listener leaves the network',
      async () => {
        handle = await startServer({
          rootDir: root,
          port: 0,
          webDistDir: webDist(),
          host: '0.0.0.0',
          tls: makeCert(),
        });
        const tlsPort = handle.tlsPort;
        expect(tlsPort).toBeGreaterThan(0);

        const overTls = await fetch(`https://127.0.0.1:${tlsPort}/api/whoami`, {
          ...insecure,
          headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
        });
        expect(overTls.status).toBe(200);

        // The CLI, MCP and desktop sidecar still reach plain loopback…
        const local = await rawFetch(
          `http://127.0.0.1:${handle.port}/api/whoami`,
          {
            headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
          }
        );
        expect(local.status).toBe(200);
        // …but nothing on the network can talk to the daemon unencrypted.
        const plainLan = await rawFetch(
          `http://${LAN_ADDRESS}:${handle.port}/api/health`
        ).then(
          () => 'answered',
          () => 'refused'
        );
        expect(plainLan).toBe('refused');
      }
    );

    it.skipIf(LAN_ADDRESS === undefined)(
      'a session cookie issued over HTTPS is Secure, and the HTTPS origin is trusted',
      async () => {
        handle = await startServer({
          rootDir: root,
          port: 0,
          webDistDir: webDist(),
          host: '0.0.0.0',
          tls: makeCert(),
        });
        const origin = `https://${LAN_ADDRESS}:${handle.tlsPort}`;
        const issued = await rawFetch(
          `http://127.0.0.1:${handle.port}/api/team/tokens`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${handle.tokens.appToken}`,
            },
            body: JSON.stringify({ email: 'ada@example.com' }),
          }
        );
        const { token } = (await issued.json()) as { token: string };
        const signedIn = await fetch(
          `https://127.0.0.1:${handle.tlsPort}/api/session`,
          {
            ...insecure,
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ token }),
          }
        );
        expect(signedIn.status).toBe(200);
        expect(signedIn.headers.get('set-cookie')).toContain('Secure');
      }
    );
  });
});
