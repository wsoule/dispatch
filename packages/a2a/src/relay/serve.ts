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
  // Connections still waiting to authenticate: per IP (8) and in all (256).
  preAuthPerIp?: number;
  preAuthTotal?: number;
  // How often tenants are pinged; one silent for two intervals is dropped.
  pingMs?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::']);
const CARD_PATH = '/.well-known/agent-card.json';
const TENANTS_PATH = '/v1/tenants';
const TENANT = /^\/t\/([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/;
const AUTH_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;
// Before auth a dialled connection may send only its auth frame.
const PRE_AUTH_BYTES = 4096;
const AFTER_AUTH_BYTES = 2 * MAX_FRAME_BODY + 4096;

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
export async function startRelay(o: RelayOptions): Promise<{
  url: string;
  port: number;
  // Re-reads the tenants file (SIGHUP) and drops tenants no longer listed.
  reload(): void;
  stop(): Promise<void>;
}> {
  const problem = checkRelay(o);
  if (problem !== null) throw new Error(problem);
  let allowed = readTenants(o.tenantsFile);
  const preAuth = new Map<string, number>();
  let preAuthTotal = 0;
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
    // Unauthenticated connections are capped per IP and in all (review M2).
    // Behind a trusted loopback tunnel, the forwarded address is the client's.
    const xff = req.headers['x-forwarded-for'];
    const forwardedIp =
      typeof xff === 'string'
        ? xff
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== '')
            .at(-1)
        : undefined;
    const ip =
      o.trustForwardedFor && LOOPBACK.has(o.host) && forwardedIp !== undefined
        ? forwardedIp
        : (req.socket.remoteAddress ?? '-');
    if (
      (preAuth.get(ip) ?? 0) >= (o.preAuthPerIp ?? 8) ||
      preAuthTotal >= (o.preAuthTotal ?? 256)
    ) {
      socket.destroy();
      return;
    }
    preAuth.set(ip, (preAuth.get(ip) ?? 0) + 1);
    preAuthTotal++;
    let counted = true;
    const authDone = () => {
      if (!counted) return;
      counted = false;
      preAuthTotal--;
      const n = (preAuth.get(ip) ?? 1) - 1;
      if (n <= 0) preAuth.delete(ip);
      else preAuth.set(ip, n);
    };
    socket.write(handshake(key));
    const conn = new WsConnection(socket, PRE_AUTH_BYTES);
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
      authDone();
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
        authDone();
        conn.setMaxMessage(AFTER_AUTH_BYTES);
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
      // Not connected reads as not listed: no oracle for who is a tenant (M4).
      const tenant = router.connOf(tp);
      if (tenant === null) {
        res.writeHead(404).end('not found');
        done(404);
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
  // Explicit, so a slow client cannot hold a socket open on headers or body.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
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
  // Pings every tenant; one silent for two intervals is half-open: dropped.
  const pingMs = o.pingMs ?? PING_MS;
  const pinger = setInterval(() => {
    for (const conn of conns) {
      if (conn.silentForMs() > 2 * pingMs) conn.close(1001);
      else conn.ping();
    }
  }, pingMs);
  pinger.unref();
  return {
    url: base,
    port,
    reload: () => {
      let next: Map<string, string>;
      try {
        next = readTenants(o.tenantsFile);
      } catch (err) {
        log(
          `relay: kept the old tenants list: ${err instanceof Error ? err.message : 'error'}`
        );
        return;
      }
      const before = allowed;
      allowed = next;
      for (const tp of before.keys()) {
        if (allowed.has(tp)) continue;
        const t = router.connOf(tp);
        if (t === null) continue;
        t.channel.close();
        t.conn.close(1008);
        log(`relay: dropped tenant ${tp.slice(0, 8)}, no longer listed`);
      }
    },
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(pinger);
        for (const conn of conns) conn.close(1001);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
