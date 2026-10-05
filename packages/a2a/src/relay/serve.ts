import type { A2AConfig } from '@dispatch/core';
import { DEFAULT_A2A } from '@dispatch/core';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { JWKS_PATH } from '../card.js';
import type { HttpBridgePort } from '../http/port.js';
import { toRequest, writeResponse } from '../http/serve.js';
import { isLoopbackHost } from '../peer/http.js';
import { handleA2A, KEY_STATEMENT_PATH } from '../server/handle.js';
import { IpLimiter } from '../server/limits.js';
import { relayBridgePort, TenantChannel } from './bridgePort.js';
import { checkAuth } from './challenge.js';
import { MAX_FRAME_BODY, parseFrame } from './frames.js';
import type { TenantLimits } from './limits.js';
import { DEFAULT_TENANT_LIMITS, TenantLimiter } from './limits.js';
import { TenantRouter } from './router.js';
import { handshake, WsConnection } from './ws.js';

// `dispatch a2a relay` (P5 piece 3): one public A2A host for many daemons.
// Each daemon dials in over a WebSocket and answers its tenant's port calls;
// the relay runs handleA2A per tenant and stores nothing but an access log.

export interface RelayOptions {
  host: string;
  // 0 picks a free port (loopback, no public URL: tests).
  port: number;
  publicUrl: string | null;
  tls: { cert: string; key: string } | null;
  publicBind: boolean;
  trustForwardedFor: boolean;
  // The allowlist: one thumbprint per line, an optional name after it.
  tenantsFile: string;
  limits?: TenantLimits;
  log?: (line: string) => void;
  // How long a dialled connection has to answer its challenge (10 s).
  authTimeoutMs?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::']);
const CARD_PATH = '/.well-known/agent-card.json';
const TENANTS_PATH = '/v1/tenants';
const TENANT = /^\/t\/([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/;
const AUTH_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;

interface Tenant {
  thumbprint: string;
  conn: WsConnection;
  channel: TenantChannel;
  port: HttpBridgePort;
  policy: A2AConfig;
}

/** The relay's allowlist, from a 0600 regular file the current user owns. */
export function readTenants(file: string): Map<string, string> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    throw new Error(`cannot read the tenants file ${file}`);
  }
  if (!st.isFile())
    throw new Error(
      `the tenants file ${file} must be a regular file, not a symlink or directory`
    );
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new Error(
      `the tenants file ${file} is not owned by the current user`
    );
  if ((Number(st.mode) & 0o077) !== 0)
    throw new Error(
      `the tenants file ${file} is readable by others; run chmod 600 on it`
    );
  const tenants = new Map<string, string>();
  for (const [i, raw] of readFileSync(file, 'utf8').split('\n').entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const m = /^([A-Za-z0-9_-]{43})(?:\s+(.{1,100}))?$/.exec(line);
    if (m === null)
      throw new Error(
        `the tenants file ${file}, line ${i + 1}: expected <thumbprint> [name]`
      );
    tenants.set(m[1], m[2] ?? '');
  }
  return tenants;
}

// The listener's rules: loopback unless --public, which needs TLS and a
// public URL; that URL https unless its host is loopback.
function checkRelay(o: RelayOptions): string | null {
  const loopback = LOOPBACK.has(o.host);
  if (!loopback && !WILDCARD.has(o.host))
    return 'host must be loopback (127.0.0.1, ::1, localhost) or a wildcard (0.0.0.0, ::)';
  if (!loopback && !o.publicBind)
    return 'binding every network interface needs --public';
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535)
    return 'port must be 1-65535';
  if (o.port === 0 && o.publicUrl !== null)
    return 'a public URL needs a fixed --port';
  if (!loopback && (o.tls === null || o.publicUrl === null))
    return 'a wildcard host needs --tls-cert, --tls-key and --public-url';
  if (o.publicUrl !== null) {
    let u: URL;
    try {
      u = new URL(o.publicUrl);
    } catch {
      return 'the public URL is not a URL';
    }
    if (u.pathname !== '/' || u.search !== '')
      return 'the public URL is an origin, with no path';
    if (!(u.protocol === 'https:' || isLoopbackHost(u.hostname)))
      return 'the public URL must be https unless its host is loopback';
  }
  return null;
}

/** Starts the relay; resolves once it listens. */
export async function startRelay(
  o: RelayOptions
): Promise<{ url: string; port: number; stop(): Promise<void> }> {
  const problem = checkRelay(o);
  if (problem !== null) throw new Error(problem);
  const allowed = readTenants(o.tenantsFile);
  const log = o.log ?? ((line: string) => console.log(line));
  const router = new TenantRouter<Tenant>();
  const limiter = new TenantLimiter(() => o.limits ?? DEFAULT_TENANT_LIMITS);
  const ipLimiter = new IpLimiter();
  const conns = new Set<WsConnection>();
  let base = (o.publicUrl ?? '').replace(/\/$/, '');

  // A tenant daemon dials in: challenge, auth, then frames until it leaves.
  const onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (
      (req.url ?? '').split('?')[0] !== TENANTS_PATH ||
      typeof key !== 'string'
    ) {
      socket.destroy();
      return;
    }
    socket.write(handshake(key));
    const conn = new WsConnection(socket, 2 * MAX_FRAME_BODY + 4096);
    conns.add(conn);
    const nonce = randomBytes(24).toString('base64url');
    const dialled = `${base.replace(/^http/, 'ws')}${TENANTS_PATH}`;
    let tenant: Tenant | null = null;
    // The nonce is this connection's alone and good once, until the timer:
    // an auth for any other nonce, or a late one, is refused.
    const timer = setTimeout(
      () => conn.close(1008),
      o.authTimeoutMs ?? AUTH_TIMEOUT_MS
    );
    timer.unref();
    conn.send(JSON.stringify({ t: 'challenge', nonce }));
    conn.onClose = () => {
      clearTimeout(timer);
      conns.delete(conn);
      if (tenant === null) return;
      router.drop(tenant.thumbprint, tenant);
      tenant.channel.close();
      log(`relay: tenant ${tenant.thumbprint.slice(0, 8)} disconnected`);
    };
    conn.onMessage = (text) => {
      let frame;
      try {
        frame = parseFrame(text, 'relay');
      } catch {
        conn.close(1003);
        return;
      }
      if (tenant === null) {
        if (frame.t !== 'auth') {
          conn.close(1008);
          return;
        }
        clearTimeout(timer);
        const checked = checkAuth(frame, dialled, nonce, (tp) =>
          allowed.has(tp)
        );
        if (!checked.ok) {
          conn.send(JSON.stringify({ t: 'refused', reason: checked.reason }));
          conn.close(1008);
          log(`relay: refused a tenant (${checked.reason})`);
          return;
        }
        const tp = checked.thumbprint;
        const channel = new TenantChannel({
          tenant: tp,
          send: (f) => conn.send(JSON.stringify(f)),
          limiter,
        });
        const admitted: Tenant = {
          thumbprint: tp,
          conn,
          channel,
          port: relayBridgePort(channel, `${base}/t/${tp}`),
          policy: { ...DEFAULT_A2A },
        };
        tenant = admitted;
        const previous = router.admit(tp, admitted);
        if (previous !== null) {
          previous.channel.close();
          previous.conn.close(1000);
        }
        conn.send(JSON.stringify({ t: 'ready' }));
        log(`relay: tenant ${tp.slice(0, 8)} connected`);
        // The daemon's own wait for blocking sends, as a standalone host reads it.
        admitted.port.card().then(
          (c) => {
            admitted.policy = {
              ...admitted.policy,
              blockingWaitSec: c.blockingWaitSec,
            };
          },
          () => undefined
        );
        return;
      }
      if (frame.t === 'result' || frame.t === 'chunk' || frame.t === 'end') {
        if (!tenant.channel.receive(frame))
          log(
            `relay: tenant ${tenant.thumbprint.slice(0, 8)} answered a call it does not own`
          );
      }
    };
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    void (async () => {
      const m = TENANT.exec(req.url ?? '/');
      const tp = m?.[1];
      const rest = m?.[2] ?? '/';
      const done = (status: number) =>
        log(
          `relay: ${tp === undefined ? '-' : tp.slice(0, 8)} ${req.method ?? 'GET'} ${rest} ${status} ${Date.now() - started}ms`
        );
      if (
        tp === undefined ||
        !allowed.has(tp) ||
        (rest !== CARD_PATH &&
          rest !== JWKS_PATH &&
          rest !== KEY_STATEMENT_PATH &&
          !rest.startsWith('/a2a/v1/'))
      ) {
        res.writeHead(404).end('not found');
        done(404);
        return;
      }
      const tenant = router.connOf(tp);
      if (tenant === null) {
        res
          .writeHead(503, {
            'content-type': 'application/json',
            'retry-after': '30',
          })
          .end(
            JSON.stringify({
              error: 'this agent is not connected to the relay',
            })
          );
        done(503);
        return;
      }
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      const request = await toRequest(
        req,
        base,
        ac.signal,
        `${rest}${m?.[3] ?? ''}`
      );
      if (request instanceof Response) {
        await writeResponse(res, request);
        done(request.status);
        return;
      }
      const peer = req.socket.remoteAddress ?? null;
      const xff = req.headers['x-forwarded-for'];
      const forwarded =
        typeof xff === 'string'
          ? xff
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
              .at(-1)
          : undefined;
      const clientIp =
        o.trustForwardedFor && LOOPBACK.has(o.host) && forwarded !== undefined
          ? forwarded
          : peer;
      let response: Response;
      try {
        response = await handleA2A(request, tenant.port, {
          basePath: '/a2a/v1',
          policy: tenant.policy,
          clientIp,
          limiter: ipLimiter,
          setRequestTimeout: (s) => req.setTimeout(s * 1000),
        });
      } catch {
        response = new Response('the agent did not answer', { status: 503 });
      }
      await writeResponse(res, response);
      done(response.status);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };

  // node:http(s) load on first use: see test/lazy-imports.test.ts.
  const server =
    o.tls === null
      ? (await import('node:http')).createServer(onRequest)
      : (await import('node:https')).createServer(
          { cert: o.tls.cert, key: o.tls.key },
          onRequest
        );
  server.on('upgrade', onUpgrade);
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  if (base === '') {
    const host = o.host === '::1' ? '[::1]' : '127.0.0.1';
    base = `http://${host}:${port}`;
  }
  const pinger = setInterval(() => {
    for (const conn of conns) conn.ping();
  }, PING_MS);
  pinger.unref();
  return {
    url: base,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(pinger);
        for (const conn of conns) conn.close(1001);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
