import { MessagingError } from '@dispatch-foo/protocol';

import { PORT_CLIENT_HEADER } from '../http/wire.js';

// The relay's tenant connection (P5 piece 3): JSON frames over one WebSocket a
// daemon dials out. A `call` is one /api/a2a/port/* request the relay's
// handleA2A makes of that daemon; `result`, `chunk` and `end` answer it.

export type RelayToDaemon =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready' }
  | { t: 'refused'; reason: string }
  | {
      t: 'call';
      id: string;
      route: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }
  // The relay no longer wants a call's answer (a stream its client left).
  | { t: 'cancel'; id: string }
  | { t: 'ping' };

export type DaemonToRelay =
  | { t: 'auth'; thumbprint: string; jwk: Record<string, string>; sig: string }
  | {
      t: 'result';
      id: string;
      status: number;
      headers: Record<string, string>;
      body: string | null;
    }
  | { t: 'chunk'; id: string; data: string }
  | { t: 'end'; id: string }
  | { t: 'pong' };

/** A call's or result's body, or a chunk, at most 256 KiB of UTF-8. */
export const MAX_FRAME_BODY = 256 * 1024;
const MAX_FRAME_BYTES = 2 * MAX_FRAME_BODY;

// The headers a call carries: the port contract's, never the host token
// (the connection is the host's identity) or anything else a client sent.
const CALL_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  PORT_CLIENT_HEADER,
]);
// What a result may set on the relay's response.
const RESULT_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'cache-control',
  'etag',
  'retry-after',
  'a2a-extensions',
  'signature',
  'signature-input',
  'content-digest',
]);

/** The allowlisted headers of a request, for a call frame. */
export function callHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of h) if (CALL_HEADERS.has(name)) out[name] = value;
  return out;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;

const bad = (why: string): never => {
  throw new MessagingError('invalid', `relay frame: ${why}`, 'frame');
};

// A string field of at most `max` UTF-8 bytes.
function str(r: Record<string, unknown>, key: string, max = 4096): string {
  const v = r[key];
  if (typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > max)
    return bad(`${key}`);
  return v;
}

const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

function id(r: Record<string, unknown>): string {
  const v = str(r, 'id');
  if (!ID.test(v)) bad('id');
  return v;
}

function body(r: Record<string, unknown>): string | null {
  if (r.body === null) return null;
  return str(r, 'body', MAX_FRAME_BODY);
}

function headers(
  r: Record<string, unknown>,
  allowed: ReadonlySet<string>
): Record<string, string> {
  const h = r.headers;
  if (typeof h !== 'object' || h === null || Array.isArray(h)) bad('headers');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h as Record<string, unknown>)) {
    if (!allowed.has(name.toLowerCase())) bad(`header ${name}`);
    if (typeof value !== 'string' || value.length > 8192) bad(`header ${name}`);
    out[name.toLowerCase()] = value as string;
  }
  return out;
}

/**
 * One frame, checked field by field. `side` is who receives it: the daemon
 * reads RelayToDaemon frames, the relay reads DaemonToRelay ones. Any defect
 * is a MessagingError; the connection should then close.
 */
export function parseFrame(raw: string, side: 'daemon'): RelayToDaemon;
export function parseFrame(raw: string, side: 'relay'): DaemonToRelay;
export function parseFrame(
  raw: string,
  side: 'daemon' | 'relay'
): RelayToDaemon | DaemonToRelay;
export function parseFrame(
  raw: string,
  side: 'daemon' | 'relay'
): RelayToDaemon | DaemonToRelay {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) bad('too large');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad('not JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return bad('not an object');
  const r = v as Record<string, unknown>;
  if (side === 'daemon') {
    switch (r.t) {
      case 'challenge': {
        const nonce = str(r, 'nonce', 64);
        if (!NONCE.test(nonce)) bad('nonce');
        return { t: 'challenge', nonce };
      }
      case 'ready':
        return { t: 'ready' };
      case 'refused':
        return { t: 'refused', reason: str(r, 'reason', 500) };
      case 'call': {
        const route = str(r, 'route', 2048);
        if (!route.startsWith('/')) bad('route');
        return {
          t: 'call',
          id: id(r),
          route,
          method: str(r, 'method', 16),
          headers: headers(r, CALL_HEADERS),
          body: body(r),
        };
      }
      case 'cancel':
        return { t: 'cancel', id: id(r) };
      case 'ping':
        return { t: 'ping' };
      default:
        return bad('unknown t');
    }
  }
  switch (r.t) {
    case 'auth': {
      const jwk = r.jwk;
      if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk))
        bad('jwk');
      const fields: Record<string, string> = {};
      for (const [k, x] of Object.entries(jwk as Record<string, unknown>)) {
        if (typeof x !== 'string') bad('jwk');
        fields[k] = x as string;
      }
      return {
        t: 'auth',
        thumbprint: str(r, 'thumbprint', 64),
        jwk: fields,
        sig: str(r, 'sig', 256),
      };
    }
    case 'result': {
      const status = r.status;
      if (
        typeof status !== 'number' ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599
      )
        bad('status');
      return {
        t: 'result',
        id: id(r),
        status: status as number,
        headers: headers(r, RESULT_HEADERS),
        body: body(r),
      };
    }
    case 'chunk':
      return { t: 'chunk', id: id(r), data: str(r, 'data', MAX_FRAME_BODY) };
    case 'end':
      return { t: 'end', id: id(r) };
    case 'pong':
      return { t: 'pong' };
    default:
      return bad('unknown t');
  }
}
