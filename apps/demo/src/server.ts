#!/usr/bin/env bun
import { DEMO } from '@dispatch/demo/paths';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { injectDemoHtml } from './inject.js';
import { parseSessionPath, proxyHttp } from './proxy.js';
import { RateLimiter } from './rateLimit.js';
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
  /** POST /session creates allowed per IP per minute; env DEMO_CREATES_PER_MINUTE. */
  createsPerMinute?: number;
  /** Concurrent upstream WS a session's bridge allows; env DEMO_WS_PER_SESSION. */
  wsPerSession?: number;
}

// Per-socket state for the WS bridge: session id (for the per-session cap),
// daemon port, token, and the upstream socket once open() has dialed it.
interface BridgeData {
  id: string;
  port: number;
  token: string | null;
  upstream?: WebSocket;
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const LANDING = join(PUBLIC_DIR, 'landing.html');
const OVERLAY = join(PUBLIC_DIR, 'overlay.js');
// The daemon holds API calls open for up to 65s; the proxy has to outlast that.
const IDLE_TIMEOUT_SECONDS = 120;
// The task-mutation route (see api.ts's `segments.length === 2 && method ===
// 'PATCH'` branch, which dispatches to updateTask) — matched against
// ParsedSessionPath.rest, which already has the `/s/<id>` prefix stripped.
const PATCH_TASK_PATH = /^\/api\/tasks\/([^/]+)$/;

// The task id a successful `PATCH /api/tasks/<id>` just changed, or
// undefined for anything else — what schedules the teammate's conflict beat.
function mutatedTaskId(
  method: string,
  rest: string,
  res: Response
): string | undefined {
  if (method !== 'PATCH' || !res.ok) return undefined;
  return PATCH_TASK_PATH.exec(rest)?.[1];
}

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
  // Trusted only because Railway's edge overwrites these; a direct-to-container
  // deployment would let a client forge the baseUrl its own page is handed.
  const host =
    req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const proto =
    forwardedProto !== null && forwardedProto !== ''
      ? (forwardedProto.split(',')[0] ?? '').trim()
      : url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

// The address the creation throttle keys on: X-Forwarded-For's LAST hop —
// the one Railway's edge itself appended, so a client-sent XFF header can
// prepend fake entries but can't overwrite this one — else the TCP peer.
function clientIp(req: Request, server: Bun.Server<BridgeData>): string {
  const xff = req.headers.get('x-forwarded-for');
  const hops = xff?.split(',') ?? [];
  const last = hops[hops.length - 1]?.trim();
  if (last !== undefined && last !== '') return last;
  return server.requestIP(req)?.address ?? 'unknown';
}

// A bad numeric env value would silently disable the guard it configures
// (`x >= NaN` is always false); log and fall back to `fallback` instead.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.error(`invalid ${name}: ${raw} (using default ${fallback})`);
    return fallback;
  }
  return parsed;
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
  const createThrottle = new RateLimiter({
    limit: opts.createsPerMinute ?? envInt('DEMO_CREATES_PER_MINUTE', 6),
  });
  const wsPerSession = opts.wsPerSession ?? envInt('DEMO_WS_PER_SESSION', 4);
  // Concurrent upstream WS currently open per session id; incremented/decremented
  // in the bridge's open/close below, never touched from the fetch handler.
  const wsCounts = new Map<string, number>();

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

  const server = Bun.serve<BridgeData>({
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
        if (!createThrottle.allow(clientIp(req, server))) {
          return json({ error: 'rate-limited' }, 429);
        }
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
      // `alive` and `ws` deliberately do not touch: the overlay polls the first
      // every 30s and connectEvents reconnects the second forever, so either
      // would keep an abandoned tab's sandbox alive. Real use hits /api/*,
      // minus the one poll excluded below.
      if (parsed.kind === 'alive') {
        return new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (parsed.kind === 'ws') {
        if ((wsCounts.get(parsed.id) ?? 0) >= wsPerSession) {
          return json({ error: 'ws-cap' }, 429);
        }
        const upgraded = server.upgrade(req, {
          data: {
            id: parsed.id,
            port: session.port,
            token: new URL(req.url).searchParams.get('token'),
          },
        });
        return upgraded ? undefined : json({ error: 'upgrade-failed' }, 400);
      }

      // The SyncChip polls GET /api/sync every few seconds unprompted, so it
      // is background noise, not activity — same reasoning as `alive` above.
      const idlePoll = req.method === 'GET' && parsed.rest === '/api/sync';
      if (!idlePoll) manager.touch(parsed.id);
      if (parsed.kind === 'html') return sessionPage(req, parsed.id, session);

      try {
        const res = await proxyHttp(req, session.port, parsed.rest);
        const taskId = mutatedTaskId(req.method, parsed.rest, res);
        if (taskId !== undefined) manager.touch(parsed.id, taskId);
        return res;
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
        wsCounts.set(ws.data.id, (wsCounts.get(ws.data.id) ?? 0) + 1);
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
        const next = (wsCounts.get(ws.data.id) ?? 1) - 1;
        if (next <= 0) wsCounts.delete(ws.data.id);
        else wsCounts.set(ws.data.id, next);
      },
    },
  });

  // Wrapped so every caller's existing server.stop() also retires the
  // throttle's sweep interval, instead of needing a second stop call.
  const stop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    createThrottle.stop();
    return stop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
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

  const port = Number(process.env.PORT ?? 3000);
  if (Number.isNaN(port)) {
    console.error(`invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  const manager = new SessionManager({ sessionsDir: DEFAULT_SESSIONS_DIR });
  const server = createDemoServer({ manager, distDir, port });
  console.log(`dispatch demo on :${server.port}`);

  const shutdown = async () => {
    // Not awaited: stop(true) can hang when a socket was closed from this side
    // (see test/server.test.ts), and killing session daemons matters more.
    void server.stop(true);
    try {
      await manager.stop();
    } finally {
      // A destroy that rejects must still exit, or the container lingers with
      // daemons up until the platform SIGKILLs it.
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
