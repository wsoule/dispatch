import { MessagingError } from '@dispatch/protocol';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

import type { GuardOptions } from './guard.js';
import { pinPublicUrl } from './guard.js';

// A peer (or a card URL) failed: status null for network errors and timeouts.
export class PeerHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly retryAfterSec: number | null = null,
    readonly reason: string | null = null
  ) {
    super(message);
    this.name = 'PeerHttpError';
  }
}

export interface StatusBox {
  status: number | null;
  retryAfterSec: number | null;
  network: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
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

// Rewrites a request to connect to the checked address while Host, SNI and the
// certificate check keep the name, so DNS cannot rebind between check and connect.
async function pinned(
  target: string,
  headers: Headers,
  guard: GuardOptions,
  signal: AbortSignal
): Promise<{ url: string; tls: object }> {
  let pin: { url: URL; address: string };
  try {
    pin = await untilAborted(pinPublicUrl(target, guard), signal);
  } catch (err) {
    const refused = err instanceof MessagingError;
    throw new PeerHttpError(
      null,
      refused ? err.message : `could not resolve the peer: ${String(err)}`,
      null,
      refused ? 'ADDRESS_REFUSED' : null
    );
  }
  const { url, address } = pin;
  const name = url.hostname;
  headers.set('host', url.host);
  const at = new URL(url.href);
  at.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return {
    url: at.href,
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
  timeoutMs: number;
  signal?: AbortSignal;
  box?: StatusBox;
  // Set for URLs a client or a decide-tier human chose: every request is
  // re-resolved, refused unless all addresses are public, and pinned.
  guard?: GuardOptions;
}

// A fetch for talking to peers: fixed headers, http(s) only, no redirects, and a
// timeout on the response headers only, so an SSE body can stay open.
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
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(o.headers))
      headers.set(name, value);
    const ac = new AbortController();
    const abort = () => ac.abort();
    o.signal?.addEventListener('abort', abort, { once: true });
    init?.signal?.addEventListener('abort', abort, { once: true });
    const timer = o.timeoutMs > 0 ? setTimeout(abort, o.timeoutMs) : null;
    try {
      let url = target;
      let tls: object | undefined;
      if (o.guard !== undefined)
        ({ url, tls } = await pinned(target, headers, o.guard, ac.signal));
      const res = await base(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: ac.signal,
        ...(tls === undefined ? {} : { tls }),
      } as RequestInit);
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
      return res;
    } catch (err) {
      if (err instanceof PeerHttpError) {
        if (err.status === null && o.box !== undefined) o.box.network = true;
        throw err;
      }
      if (o.box !== undefined) o.box.network = true;
      throw new PeerHttpError(
        null,
        `could not reach the peer: ${(err as Error).message}`
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
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
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      tooBig();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
