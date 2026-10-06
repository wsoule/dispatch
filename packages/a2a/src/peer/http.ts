import { MessagingError } from '@dispatch-foo/protocol';
import { isIP } from 'node:net';

import type { GuardOptions } from './guard.js';
import { pinPublicUrl, UnresolvedHostError } from './guard.js';

// A peer (or a card URL) failed: status null for network errors and timeouts.
// `message` is Dispatch's words; whatever the peer said is in `peerText`.
export class PeerHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly retryAfterSec: number | null = null,
    readonly reason: string | null = null,
    readonly peerText: string | null = null
  ) {
    super(message);
    this.name = 'PeerHttpError';
  }
}

export interface StatusBox {
  status: number | null;
  retryAfterSec: number | null;
  network: boolean;
  // The google.rpc.ErrorInfo reason of an error response, when it names one.
  reason?: string | null;
}

const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';

// The first ErrorInfo reason in an A2A error body, or null.
function errorInfoReason(text: string): string | null {
  try {
    const details = (
      JSON.parse(text) as { error?: { details?: unknown } } | null
    )?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details as Record<string, unknown>[])
      if (d['@type'] === ERROR_INFO && typeof d.reason === 'string')
        return d.reason;
  } catch {
    // Not JSON: no reason.
  }
  return null;
}

// Exactly `localhost`, ::1 or a 127/8 IPv4 literal; `127.0.0.1.example` is a name.
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

function retryAfterOf(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(seconds))
    return Math.max(0, Math.round(seconds));
  const at = Date.parse(raw);
  return Number.isNaN(at)
    ? null
    : Math.max(0, Math.round((at - Date.now()) / 1000));
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// Settles with `work`, or rejects once `signal` aborts (a hung DNS lookup has no abort of its own).
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timed out'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// Rewrites a request to connect to each checked address in turn while Host,
// SNI and the certificate check keep the name, so DNS cannot rebind between
// check and connect.
async function pinned(
  target: string,
  headers: Headers,
  guard: GuardOptions,
  signal: AbortSignal
): Promise<{ urls: string[]; tls: object }> {
  let pin: { url: URL; addresses: string[] };
  try {
    pin = await untilAborted(pinPublicUrl(target, guard), signal);
  } catch (err) {
    // A name that does not resolve is a network failure; any other guard
    // refusal (a blocked address, a bad URL) is final.
    const refused =
      err instanceof MessagingError && !(err instanceof UnresolvedHostError);
    throw new PeerHttpError(
      null,
      refused
        ? err.message
        : `could not resolve the peer: ${err instanceof Error ? err.message : String(err)}`,
      null,
      refused ? 'ADDRESS_REFUSED' : null
    );
  }
  const { url, addresses } = pin;
  const name = url.hostname;
  // Loaded here, not at import: see test/lazy-imports.test.ts.
  const { checkServerIdentity } = await import('node:tls');
  headers.set('host', url.host);
  const urls = addresses.map((address) => {
    const at = new URL(url.href);
    at.hostname = isIP(address) === 6 ? `[${address}]` : address;
    return at.href;
  });
  return {
    urls,
    tls: {
      serverName: name,
      checkServerIdentity: (_host: string, cert: never) =>
        checkServerIdentity(name, cert),
    },
  };
}

export interface PeerFetchOptions {
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  // The deadline for headers and, except for event streams, the whole body.
  timeoutMs: number;
  signal?: AbortSignal;
  box?: StatusBox;
  // Set for URLs a client or a decide-tier human chose: every request is
  // re-resolved, refused unless all addresses are public, and pinned.
  guard?: GuardOptions;
  // The body cap for anything but an event stream; 1 MiB by default.
  maxBodyBytes?: number;
  // How long an event stream may go without a byte; 60 s by default.
  idleMs?: number;
}

type ChunkRead =
  | { done: true; value?: undefined }
  | { done: false; value: Uint8Array };

export const MAX_BODY_BYTES = 1024 * 1024;
const STREAM_IDLE_MS = 60_000;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// The response with its body counted and timed: past `maxBytes` it errors
// BODY_TOO_LARGE, and an abort (deadline, idle or caller) errors as a network
// failure. `done` runs once the body ends, errors or is cancelled.
function guardedBody(
  res: Response,
  o: {
    ac: AbortController;
    maxBytes: number;
    box: StatusBox | undefined;
    idleMs: number | null;
    done: () => void;
  }
): Response {
  if (res.body === null || NULL_BODY_STATUSES.has(res.status)) {
    o.done();
    return res;
  }
  const reader = res.body.getReader();
  let total = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (o.idleMs === null) return;
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => o.ac.abort(), o.idleMs);
  };
  const finish = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    o.done();
  };
  armIdle();
  // Unblocks a pending read the moment the deadline, idle timer or caller aborts.
  o.ac.signal.addEventListener(
    'abort',
    () => {
      void reader.cancel().catch(() => undefined);
    },
    { once: true }
  );
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const cutOff = () => {
        finish();
        if (o.box !== undefined) o.box.network = true;
        controller.error(
          new PeerHttpError(null, "timed out reading the peer's response")
        );
      };
      let chunk: ChunkRead;
      try {
        chunk = (await reader.read()) as ChunkRead;
      } catch {
        cutOff();
        return;
      }
      // An abort can end the read as a clean finish; it is still a cut-off.
      if (o.ac.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        cutOff();
        return;
      }
      if (chunk.done === true) {
        finish();
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > o.maxBytes) {
        finish();
        await reader.cancel().catch(() => undefined);
        controller.error(
          new PeerHttpError(
            res.status,
            `the peer's response is over ${o.maxBytes} bytes`,
            null,
            'BODY_TOO_LARGE'
          )
        );
        return;
      }
      armIdle();
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

// A fetch for talking to peers: fixed headers, http(s) only, no redirects, a
// deadline over headers and body, and a body cap. An event stream (the caller
// accepts text/event-stream) instead ends after `idleMs` without a byte.
export function peerFetch(o: PeerFetchOptions): typeof fetch {
  const base = o.fetchImpl ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = urlOf(input);
    let protocol: string;
    try {
      protocol = new URL(target).protocol;
    } catch {
      throw new PeerHttpError(400, `not a URL: ${target.slice(0, 80)}`);
    }
    if (protocol !== 'https:' && protocol !== 'http:')
      throw new PeerHttpError(
        400,
        `only http and https are fetched, not ${protocol}`
      );
    let headers: Headers;
    try {
      headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(o.headers))
        headers.set(name, value);
    } catch {
      // The runtime's message can quote the value, which may be a credential.
      throw new PeerHttpError(400, 'a request header could not be sent');
    }
    const stream = (headers.get('accept') ?? '').includes('text/event-stream');
    const ac = new AbortController();
    const abort = () => ac.abort();
    o.signal?.addEventListener('abort', abort, { once: true });
    init?.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null =
      o.timeoutMs > 0 ? setTimeout(abort, o.timeoutMs) : null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    try {
      let urls = [target];
      let tls: object | undefined;
      if (o.guard !== undefined)
        ({ urls, tls } = await pinned(target, headers, o.guard, ac.signal));
      // A body stream cannot be sent twice, so only a replayable one falls back.
      const replayable = !(init?.body instanceof ReadableStream);
      let res: Response | null = null;
      for (const [i, url] of urls.entries()) {
        try {
          res = await base(url, {
            ...init,
            headers,
            redirect: 'manual',
            signal: ac.signal,
            ...(tls === undefined ? {} : { tls }),
          } as RequestInit);
          break;
        } catch (err) {
          if (ac.signal.aborted || !replayable || i === urls.length - 1)
            throw err;
        }
      }
      if (res === null) throw new Error('no address to connect to');
      if (o.box !== undefined) {
        o.box.status = res.status;
        o.box.retryAfterSec = retryAfterOf(res);
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await res.body?.cancel().catch(() => undefined);
        throw new PeerHttpError(
          res.status,
          'the peer redirected; redirects are not followed'
        );
      }
      // An event stream lives on its idle timeout and the caller's signal.
      if (stream) clear();
      const guarded = guardedBody(res, {
        ac,
        maxBytes: stream
          ? Number.POSITIVE_INFINITY
          : (o.maxBodyBytes ?? MAX_BODY_BYTES),
        box: o.box,
        idleMs: stream ? (o.idleMs ?? STREAM_IDLE_MS) : null,
        done: clear,
      });
      if (res.status < 400 || o.box === undefined) return guarded;
      // Read here so the caller learns the reason the SDK's error drops.
      const text = await guarded.text();
      o.box.reason = errorInfoReason(text);
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (err) {
      clear();
      if (err instanceof PeerHttpError) {
        if (err.status === null && o.box !== undefined) o.box.network = true;
        throw err;
      }
      if (o.box !== undefined) o.box.network = true;
      throw new PeerHttpError(
        null,
        `could not reach the peer: ${(err as Error).message}`
      );
    }
  }) as typeof fetch;
}

// The body as text, refusing past `maxBytes` without reading the rest.
export async function readCapped(
  res: Response,
  maxBytes: number,
  field: string
): Promise<string> {
  const tooBig = (): never => {
    throw new MessagingError(
      'invalid',
      `${field}: the response is over ${maxBytes} bytes`,
      field
    );
  };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    tooBig();
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: ChunkRead;
    try {
      next = (await reader.read()) as ChunkRead;
    } catch (err) {
      if (err instanceof PeerHttpError && err.reason === 'BODY_TOO_LARGE')
        return tooBig();
      throw err;
    }
    const { done, value } = next;
    if (done === true) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      tooBig();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
