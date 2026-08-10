#!/usr/bin/env bun
import { DEMO } from '@dispatch/demo/paths';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { injectDemoHtml } from './inject.js';
import { parseSessionPath, proxyHttp } from './proxy.js';
import {
  DEFAULT_SESSIONS_DIR,
  type Session,
  SessionCapError,
  SessionManager,
} from './sessions.js';

export interface DemoServerOptions {
  manager: SessionManager;
  /** The desktop Vite bundle; its index.html is what /s/<id>/ serves. */
  distDir: string;
  port?: number;
}

// Per-socket state for the WS bridge: the daemon port to dial, the token the
// page put in the query, and the upstream socket once open() has dialed it.
interface BridgeData {
  port: number;
  token: string | null;
  upstream?: WebSocket;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const LANDING = join(PUBLIC_DIR, 'landing.html');
const OVERLAY = join(PUBLIC_DIR, 'overlay.js');
// The daemon holds API calls open for up to 65s; the proxy has to outlast that.
const IDLE_TIMEOUT_SECONDS = 120;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

// The landing page, also used as the body of a 404 so an expired /s/<id>/
// link lands somewhere that offers a fresh sandbox instead of a bare error.
function landing(status = 200): Response {
  return new Response(Bun.file(LANDING), {
    status,
    headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
  });
}

// The origin visitors actually typed, which behind Railway's edge is not the
// one this process bound — an injected baseUrl of the latter reaches nothing.
function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host =
    req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const proto =
    forwardedProto !== null && forwardedProto !== ''
      ? (forwardedProto.split(',')[0] ?? '').trim()
      : url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

// Maps a request path to a file inside `dir`, or null if it escapes. Containment
// is asserted, not assumed — see apps/site/server.ts for why URL() is unsafe here.
function resolveInDir(dir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const root = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const full = resolve(dir, `.${decoded}`);
  return full.startsWith(root) ? full : null;
}

/**
 * The public demo server: a landing page, a session factory, and a per-session
 * reverse proxy (HTTP + WS) onto that visitor's own dispatchd. Exported so
 * tests can boot it on port 0 against a stubbed manager.
 */
export function createDemoServer(
  opts: DemoServerOptions
): Bun.Server<BridgeData> {
  const { manager } = opts;
  const distDir = resolve(opts.distDir);

  // Serves the desktop bundle's index.html with the session's tokens injected.
  // no-store because those tokens are per-session credentials.
  async function sessionPage(
    req: Request,
    id: string,
    session: Session
  ): Promise<Response> {
    const file = Bun.file(join(distDir, 'index.html'));
    if (!(await file.exists())) {
      return json({ error: 'ui-bundle-missing' }, 500);
    }
    const html = injectDemoHtml(await file.text(), {
      baseUrl: `${publicOrigin(req)}/s/${id}`,
      root: session.paths.root,
      agentToken: session.agentToken,
      appToken: session.appToken,
      embed: new URL(req.url).searchParams.get('embed') === '1',
    });
    return new Response(html, {
      headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
    });
  }

  return Bun.serve<BridgeData>({
    port: opts.port ?? 3000,
    hostname: '0.0.0.0',
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    error(err) {
      console.error('demo server error', err);
      return json({ error: 'internal' }, 500);
    },
    async fetch(req, server) {
      const { pathname } = new URL(req.url);

      if (pathname === '/') return landing();
      if (pathname === '/demo-overlay.js') {
        return new Response(Bun.file(OVERLAY), {
          headers: {
            'content-type': 'text/javascript',
            'cache-control': 'no-cache',
          },
        });
      }

      if (pathname === '/session') {
        if (req.method !== 'POST') return json({ error: 'method' }, 405);
        try {
          const session = await manager.create();
          return json({ id: session.id }, 201);
        } catch (err) {
          if (err instanceof SessionCapError)
            return json({ error: 'busy' }, 503);
          // Seeding or spawning blew up (or the manager is mid-shutdown):
          // a server fault, not backpressure, so it must not read as "busy".
          console.error('session create failed', err);
          return json({ error: 'start-failed' }, 500);
        }
      }

      const parsed = parseSessionPath(pathname);
      if (parsed === null) {
        // Nothing under /s/ is ever a static file — a stale deep link must not
        // be able to probe distDir through the session namespace.
        if (pathname.startsWith('/s/'))
          return json({ error: 'not-found' }, 404);
        const file = resolveInDir(distDir, pathname);
        if (file !== null && (await Bun.file(file).exists())) {
          // Nothing here is content-hashed in a way this server can rely on,
          // so revalidate rather than pin a visitor to one deploy's bundle.
          return new Response(Bun.file(file), {
            headers: { 'cache-control': 'no-cache' },
          });
        }
        return landing(404);
      }

      const session = manager.get(parsed.id);
      if (session === undefined) {
        return parsed.kind === 'html'
          ? landing(404)
          : json({ error: 'session-expired' }, 404);
      }
      manager.touch(parsed.id);

      if (parsed.kind === 'alive') return new Response(null, { status: 200 });
      if (parsed.kind === 'html') return sessionPage(req, parsed.id, session);
      if (parsed.kind === 'ws') {
        const upgraded = server.upgrade(req, {
          data: {
            port: session.port,
            token: new URL(req.url).searchParams.get('token'),
          },
        });
        return upgraded ? undefined : json({ error: 'upgrade-failed' }, 400);
      }

      try {
        return await proxyHttp(req, session.port, parsed.rest);
      } catch (err) {
        // The daemon died under a session we still had a record for. Treat it
        // exactly like an expiry so the overlay offers a fresh sandbox.
        console.error(`session ${parsed.id} daemon unreachable`, err);
        await manager.destroy(parsed.id);
        return json({ error: 'session-expired' }, 404);
      }
    },
    websocket: {
      open(ws) {
        const upstream = new WebSocket(
          `ws://127.0.0.1:${ws.data.port}/ws?token=${encodeURIComponent(ws.data.token ?? '')}`
        );
        ws.data.upstream = upstream;
        upstream.onmessage = (event) => {
          ws.send(event.data as string);
        };
        upstream.onclose = () => {
          ws.close();
        };
        upstream.onerror = () => {
          ws.close();
        };
      },
      // The daemon's /ws is server->client only; anything the page sends is
      // not part of the protocol, so it is dropped rather than forwarded.
      message() {},
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
}

/**
 * Fails fast on the four things a container can be missing that would
 * otherwise only surface as a broken session minutes later.
 */
function bootSelfCheck(sessionsDir: string, distDir: string): void {
  const problems: string[] = [];

  const git = Bun.spawnSync(['git', '--version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (!git.success)
    problems.push('git is not on PATH (session seeding needs it)');

  if (!existsSync(DEMO.template)) {
    problems.push(`storefront template missing at ${DEMO.template}`);
  }
  if (!existsSync(join(distDir, 'index.html'))) {
    problems.push(
      `desktop bundle missing at ${distDir} (run: bun run build in apps/desktop)`
    );
  }

  try {
    mkdirSync(sessionsDir, { recursive: true });
    const probe = join(sessionsDir, '.write-probe');
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (err) {
    problems.push(
      `sessions dir ${sessionsDir} is not writable: ${String(err)}`
    );
  }

  if (problems.length > 0) {
    console.error(`demo server preflight failed:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const distDir =
    process.env.DEMO_DIST_DIR ??
    fileURLToPath(new URL('../../desktop/dist/', import.meta.url));

  // Anything left in the sessions dir belongs to a previous process that is no
  // longer running; reap before the write probe recreates the directory.
  SessionManager.reap(DEFAULT_SESSIONS_DIR);
  bootSelfCheck(DEFAULT_SESSIONS_DIR, distDir);

  const manager = new SessionManager({ sessionsDir: DEFAULT_SESSIONS_DIR });
  const server = createDemoServer({
    manager,
    distDir,
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`dispatch demo on :${server.port}`);

  const shutdown = async () => {
    // stop(true) is never awaited: in Bun 1.3 its promise does not resolve
    // once the server has served a WebSocket, and killing daemons matters more.
    void server.stop(true);
    await manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
