import type { A2AConfig } from '@dispatch/core';
import { DEFAULT_A2A } from '@dispatch/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

import { JWKS_PATH } from '../card.js';
import { isLoopbackHost } from '../peer/http.js';
import { handleA2A } from '../server/handle.js';
import { IpLimiter } from '../server/limits.js';
import { HttpBridgePort } from './port.js';

export interface StandaloneOptions {
  host: string;
  port: number;
  publicUrl: string | null;
  tls: { cert: string; key: string } | null;
  // The explicit opt-in a wildcard bind needs; loopback is the default.
  publicBind: boolean;
  trustForwardedFor: boolean;
  daemonUrl: string;
  hostToken: string;
  fetchImpl?: typeof fetch;
}

export type StandaloneCheck =
  | { ok: true; publicUrl: string }
  | { ok: false; key: string; error: string };

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::']);
const MAX_BODY = 262_144;
const CARD_PATH = '/.well-known/agent-card.json';

function httpsOrLoopback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' ||
      (u.protocol === 'http:' && isLoopbackHost(u.hostname))
    );
  } catch {
    return false;
  }
}

// The daemon listener's own rules (spec:648-669, 1706-1707): loopback by
// default, a wildcard only with the explicit public-bind flag, TLS and a
// public URL; and an https daemon unless it runs on this machine (spec:1673-1675).
export function checkStandalone(
  o: Pick<
    StandaloneOptions,
    'host' | 'port' | 'publicUrl' | 'tls' | 'daemonUrl' | 'publicBind'
  >
): StandaloneCheck {
  const loopback = LOOPBACK.has(o.host);
  if (!loopback && !WILDCARD.has(o.host))
    return {
      ok: false,
      key: 'host',
      error:
        'host must be loopback (127.0.0.1, ::1, localhost) or a wildcard (0.0.0.0, ::)',
    };
  if (!loopback && !o.publicBind)
    return {
      ok: false,
      key: 'host',
      error: 'binding every network interface needs --public',
    };
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)
    return {
      ok: false,
      key: 'port',
      error: 'port is required (1-65535): the card needs a stable port',
    };
  if (!loopback && o.tls === null)
    return {
      ok: false,
      key: 'tls',
      error: 'a wildcard host needs --tls-cert and --tls-key',
    };
  if (!loopback && o.publicUrl === null)
    return {
      ok: false,
      key: 'publicUrl',
      error: 'a wildcard host needs --public-url',
    };
  const host =
    o.host === '::1' ? '[::1]' : o.host === 'localhost' ? '127.0.0.1' : o.host;
  const publicUrl = (o.publicUrl ?? `http://${host}:${o.port}`).replace(
    /\/$/,
    ''
  );
  if (!httpsOrLoopback(publicUrl))
    return {
      ok: false,
      key: 'publicUrl',
      error: 'the public URL must be https unless its host is loopback',
    };
  if (!httpsOrLoopback(o.daemonUrl))
    return {
      ok: false,
      key: 'daemon',
      error: 'reach a remote daemon over its team-local TLS listener (https)',
    };
  return { ok: true, publicUrl };
}

// Node's request as a fetch Request at the configured public URL (never the
// Host header), the body capped at 256 KiB; aborted when the client leaves.
async function toRequest(
  req: IncomingMessage,
  origin: string,
  signal: AbortSignal
): Promise<Request | Response> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BODY)
        return new Response('request body over 256 KiB', { status: 413 });
      chunks.push(chunk as Buffer);
    }
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const init: RequestInit = { method: req.method ?? 'GET', headers, signal };
  if (chunks.length > 0) init.body = new Uint8Array(Buffer.concat(chunks));
  return new Request(new URL(req.url ?? '/', origin).href, init);
}

async function writeResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  const reader = response.body?.getReader();
  if (reader === undefined) {
    res.end();
    return;
  }
  res.on('close', () => {
    reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const next = (await reader.read()) as
      | { done: true; value?: undefined }
      | { done: false; value: Uint8Array };
    if (next.done) break;
    res.write(next.value);
  }
  res.end();
}

// What `dispatch a2a serve` runs: handleA2A over HttpBridgePort on
// node:http(s), so it works under Node (the published CLI) and Bun alike.
export async function startStandalone(
  o: StandaloneOptions
): Promise<{ url: string; port: number; stop(): Promise<void> }> {
  const checked = checkStandalone(o);
  if (!checked.ok) throw new Error(`${checked.key}: ${checked.error}`);
  const port = new HttpBridgePort({
    daemonUrl: o.daemonUrl.replace(/\/$/, ''),
    hostToken: o.hostToken,
    publicUrl: checked.publicUrl,
    ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
  });
  const limiter = new IpLimiter();
  let policy: A2AConfig = {
    ...DEFAULT_A2A,
    blockingWaitSec: (await port.card()).blockingWaitSec,
  };
  const refresh = setInterval(() => {
    port.card().then(
      (c) => {
        policy = { ...policy, blockingWaitSec: c.blockingWaitSec };
      },
      () => undefined
    );
  }, 60_000);
  refresh.unref();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (
        path !== CARD_PATH &&
        path !== JWKS_PATH &&
        !path.startsWith('/a2a/v1/')
      ) {
        res.writeHead(404).end('not found');
        return;
      }
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      const request = await toRequest(req, checked.publicUrl, ac.signal);
      if (request instanceof Response) {
        await writeResponse(res, request);
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
      // Forwarded addresses count only behind a loopback-bound tunnel.
      const clientIp =
        o.trustForwardedFor && LOOPBACK.has(o.host) && forwarded !== undefined
          ? forwarded
          : peer;
      const response = await handleA2A(request, port, {
        basePath: '/a2a/v1',
        policy,
        clientIp,
        limiter,
        setRequestTimeout: (s) => req.setTimeout(s * 1000),
      });
      await writeResponse(res, response);
    })().catch((err: unknown) => {
      console.error(
        `a2a serve: request failed: ${err instanceof Error ? err.name : 'error'}`
      );
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const server =
    o.tls === null
      ? createHttpServer(handler)
      : createHttpsServer({ cert: o.tls.cert, key: o.tls.key }, handler);
  // Tracked so stop() can end keep-alive and SSE connections on Node and Bun alike.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  return {
    url: checked.publicUrl,
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(refresh);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
