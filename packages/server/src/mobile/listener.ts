import { extname, join, resolve, sep } from 'node:path';

import { deviceMayReach } from './allowlist.js';

// The phone's way in: its own Bun.serve, never one of the daemon's /api
// listeners, answering the mobile web app, pairing (`POST /api/pair`, the
// daemon's own open route) and the routes a paired phone may reach
// (allowlist.ts).
//
// It exists because every easy way to reach a laptop from a phone — `tailscale
// serve`, a Cloudflare tunnel, a local Caddy — delivers requests from
// 127.0.0.1. The main listener trusts loopback: it inlines the agent token
// into the page it serves and accepts every loopback origin. Pointing a tunnel
// at it would hand that token to whoever reaches the tunnel. This listener
// trusts nothing about where a request came from:
//
// - it never injects a credential into a page;
// - every API request must carry a paired device's token as a bearer, and
//   cookies are never read, so no other site can make a request on a phone's
//   behalf;
// - it sends no CORS headers, so no other origin can read a response;
// - it forwards to handleApi with the Origin and Cookie headers stripped, after
//   checking the token is a device's and the route is one a device may reach.

export interface MobileListenerDeps {
  /** The daemon's API router, bound to its context. */
  handleApi: (req: Request) => Promise<Response>;
  /** Whether a presented bearer token belongs to a paired device. */
  isDeviceToken: (token: string) => boolean;
  /** The built desktop bundle, whose `m/` holds the mobile app and whose
   *  `assets/` the chunks it shares. Null serves no web app (API only). */
  distDir: string | null;
  /** Wraps a request so idle shutdown sees it. */
  track?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// On every response: nothing here may be framed by another site, sniffed into
// another type, or leak a URL (the pairing link's code rides in the fragment,
// which browsers never send, but belt and braces).
const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const MAX_BODY_BYTES = 256 * 1024;

function withBase(res: Response): Response {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match === null ? null : match[1];
}

/** A file under `dir` for a URL path below it, or null when the path would
 *  climb out of it. */
function fileWithin(dir: string, relative: string): string | null {
  const root = resolve(dir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const target = resolve(root, decoded);
  return target.startsWith(root + sep) ? target : null;
}

async function serveFile(
  path: string,
  cache: string
): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const type = CONTENT_TYPES[extname(path)];
  return new Response(file, {
    headers: {
      ...(type === undefined ? {} : { 'content-type': type }),
      'cache-control': cache,
    },
  });
}

/** Routes one request on the mobile listener. Exported apart from the server
 *  so tests can drive it without a socket. */
export async function serveMobile(
  req: Request,
  deps: MobileListenerDeps
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/' || path === '/m') {
    return withBase(
      new Response(null, { status: 308, headers: { location: '/m/' } })
    );
  }

  if (path.startsWith('/api/')) {
    // Pairing is how a phone gets a token, so it is the one route that
    // carries none; the daemon's handler checks the one-time code itself.
    const pairing = req.method === 'POST' && path === '/api/pair';
    const token = bearer(req);
    if (!pairing && (token === null || !deps.isDeviceToken(token))) {
      return withBase(
        json(401, {
          error:
            'this phone is not paired with this daemon (or was unpaired); pair it again with `dispatch mobile pair`',
          code: 'mobile_unpaired',
        })
      );
    }
    const segments = path
      .slice('/api/'.length)
      .split('/')
      .filter((s) => s !== '');
    if (!pairing && !deviceMayReach(req.method, segments)) {
      return withBase(
        json(403, {
          error: 'a paired phone cannot reach this route',
          code: 'mobile_route',
        })
      );
    }
    const length = Number(req.headers.get('content-length') ?? '0');
    if (length > MAX_BODY_BYTES)
      return withBase(json(413, { error: 'request body too large' }));
    // A fresh request to handleApi: the same method, path, query and body,
    // and only the headers the API reads for these routes. Dropping Origin
    // means the router sees a non-browser client (it has no notion of the
    // tunnel's origin, and needs none: the bearer is the whole credential).
    const headers = new Headers(
      pairing || token === null ? {} : { authorization: `Bearer ${token}` }
    );
    const type = req.headers.get('content-type');
    if (type !== null) headers.set('content-type', type);
    const key = req.headers.get('idempotency-key');
    if (key !== null) headers.set('idempotency-key', key);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const forwarded = new Request(`http://127.0.0.1${path}${url.search}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
    });
    const run = () => deps.handleApi(forwarded);
    const res = await (deps.track === undefined ? run() : deps.track(run));
    // handleApi's own responses never carry CORS here (no Origin was sent),
    // but a new Response keeps its headers mutable whatever produced it.
    const out = new Response(res.body, {
      status: res.status,
      headers: res.headers,
    });
    out.headers.set('cache-control', 'no-store');
    out.headers.delete('access-control-allow-origin');
    return withBase(out);
  }

  if (
    deps.distDir !== null &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    // Hashed chunks never change under a name; everything else revalidates so
    // an updated daemon's app reaches the phone on its next open.
    if (path.startsWith('/assets/')) {
      const file = fileWithin(join(deps.distDir, 'assets'), path.slice(8));
      const res =
        file === null
          ? null
          : await serveFile(file, 'public, max-age=31536000, immutable');
      if (res !== null) return withBase(res);
    } else if (path.startsWith('/m/')) {
      const mDir = join(deps.distDir, 'm');
      const relative = path.slice(3);
      const file =
        relative === '' ? join(mDir, 'index.html') : fileWithin(mDir, relative);
      const res = file === null ? null : await serveFile(file, 'no-cache');
      if (res !== null) {
        // The service worker governs all of /m/ from /m/sw.js; saying so
        // explicitly keeps that true behind a proxy that rewrites paths.
        if (relative === 'sw.js')
          res.headers.set('service-worker-allowed', '/m/');
        return withBase(res);
      }
      // Client-side routes: anything without an extension is the app.
      if (extname(relative) === '') {
        const index = await serveFile(join(mDir, 'index.html'), 'no-cache');
        if (index !== null) return withBase(index);
      }
    }
  }

  return withBase(new Response('not found', { status: 404 }));
}

/** The mobile listener's server: open on a loopback port, close on demand. */
export class MobileListener {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly deps: MobileListenerDeps) {}

  /** Opens on 127.0.0.1:`port` (0 picks one); answers the bound port. */
  open(
    port: number
  ): { ok: true; port: number } | { ok: false; error: string } {
    if (this.server !== null) return { ok: true, port: this.port() ?? port };
    try {
      this.server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        maxRequestBodySize: MAX_BODY_BYTES,
        development: false,
        error: (err) => {
          console.error(`dispatchd: mobile listener error: ${err.message}`);
          return withBase(json(500, { error: 'internal error' }));
        },
        fetch: (req, srv) => {
          // Long enough for a reply that wakes a run; a phone never long-polls.
          srv.timeout(req, 65);
          return serveMobile(req, this.deps);
        },
      });
      return { ok: true, port: this.server.port ?? port };
    } catch (err) {
      return {
        ok: false,
        error: `could not listen on 127.0.0.1:${port}: ${(err as Error).message}`,
      };
    }
  }

  port(): number | null {
    return this.server?.port ?? null;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop(true);
  }
}
