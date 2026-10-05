import type { A2APolicy, BridgePort } from '@dispatch/a2a';
import {
  errorResponse,
  handleA2A,
  IpLimiter,
  KEY_STATEMENT_PATH,
} from '@dispatch/a2a';

import type { ResolvedListener } from './settings.js';
import { clientIpFor } from './settings.js';

const MAX_REQUEST_BODY = 256 * 1024;
const CARD_PATH = '/.well-known/agent-card.json';
const JWKS_PATH = '/.well-known/jwks.json';
const BASE_PATH = '/a2a/v1';

interface ListenerDeps {
  port: BridgePort;
  policy: () => A2APolicy;
  // The daemon's watchdog section label for each request.
  mark?: (label: string) => void;
  // The daemon's idle tracker, so a request in flight keeps it awake.
  track?: (fn: () => Promise<Response>) => Promise<Response>;
  log?: (line: string) => void;
}

// A loopback port nothing holds right now: the OS picks it for a moment's bind.
export function freeLoopbackPort(): number | null {
  try {
    const probe = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(''),
    });
    const port = probe.port ?? null;
    void probe.stop(true);
    return port;
  } catch {
    return null;
  }
}

// The A2A listener: its own Bun.serve, never one of the daemon's /api
// listeners, answering only the agent card and the A2A routes.
export class A2AListener {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private current: ResolvedListener | null = null;
  private readonly limiter = new IpLimiter();

  constructor(private readonly deps: ListenerDeps) {}

  // One access line per request: never the Authorization header, the query
  // string or a body.
  private access(
    clientIp: string | null,
    method: string,
    pathname: string,
    status: number,
    started: number
  ): void {
    (this.deps.log ?? console.log)(
      `a2a: ${clientIp ?? '-'} ${method} ${pathname} ${status} ${Math.round(performance.now() - started)}ms`
    );
  }

  private async serve(
    req: Request,
    srv: Bun.Server<undefined>,
    listener: ResolvedListener
  ): Promise<Response> {
    const started = performance.now();
    const { pathname } = new URL(req.url);
    this.deps.mark?.(`a2a ${req.method} ${pathname}`);
    const clientIp = clientIpFor(
      req,
      srv.requestIP(req)?.address ?? null,
      listener.trustForwardedFor
    );
    if (
      pathname !== CARD_PATH &&
      pathname !== JWKS_PATH &&
      pathname !== KEY_STATEMENT_PATH &&
      !pathname.startsWith(`${BASE_PATH}/`)
    ) {
      this.access(clientIp, req.method, pathname, 404, started);
      return new Response('not found', { status: 404 });
    }
    const run = () =>
      handleA2A(req, this.deps.port, {
        basePath: BASE_PATH,
        policy: this.deps.policy(),
        clientIp,
        limiter: this.limiter,
        setRequestTimeout: (seconds) => srv.timeout(req, seconds),
      });
    const res = await (this.deps.track === undefined
      ? run()
      : this.deps.track(run));
    this.access(clientIp, req.method, pathname, res.status, started);
    return res;
  }

  open(
    listener: ResolvedListener
  ): { ok: true } | { ok: false; error: string } {
    if (this.server !== null)
      return { ok: false, error: 'the A2A listener is already open' };
    try {
      this.server = Bun.serve({
        hostname: listener.host,
        port: listener.port,
        maxRequestBodySize: MAX_REQUEST_BODY,
        ...(listener.tls === null
          ? {}
          : {
              tls: {
                cert: Bun.file(listener.tls.certPath),
                key: Bun.file(listener.tls.keyPath),
              },
            }),
        // This port faces the internet: an escaped error is logged and answered
        // in the A2A error shape, never with Bun's page of stack and paths.
        development: false,
        error: (err) => errorResponse(err),
        fetch: (req, srv) => this.serve(req, srv, listener),
      });
      this.current = listener;
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `could not listen on ${listener.host}:${listener.port}: ${(err as Error).message}`,
      };
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.current = null;
    await server?.stop(true);
  }

  url(): string | null {
    return this.current?.publicUrl ?? null;
  }
}
