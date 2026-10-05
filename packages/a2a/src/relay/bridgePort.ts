import { randomBytes } from 'node:crypto';

import { HttpBridgePort } from '../http/port.js';
import type { DaemonToRelay, RelayToDaemon } from './frames.js';
import { callHeaders, MAX_FRAME_BODY } from './frames.js';
import type { TenantLimiter } from './limits.js';

// One tenant's side of the relay: a fetch whose requests become `call` frames
// on that tenant's connection, so HttpBridgePort (and so handleA2A) runs over
// it unchanged. Each tenant has its own channel, deadlines and limits; one
// stalled tenant delays no other.

const PORT_PREFIX = '/api/a2a/port';
// As HttpBridgePort's call timeout: a blocking open waits up to 600 s.
const DEADLINE_MS = 700_000;

interface Pending {
  stream: boolean;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  done: () => void;
}

class TenantGone extends Error {
  constructor(why: string) {
    super(`the tenant's daemon is not connected: ${why}`);
  }
}

export interface TenantChannelOptions {
  tenant: string;
  send: (frame: RelayToDaemon) => void;
  limiter: TenantLimiter;
  deadlineMs?: number;
}

export class TenantChannel {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly o: TenantChannelOptions) {}

  /** A fetch over this tenant's connection; only /api/a2a/port/* routes. */
  readonly fetch = (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url
    );
    if (this.closed) return Promise.reject(new TenantGone('closed'));
    if (!url.pathname.startsWith(PORT_PREFIX))
      return Promise.resolve(new Response('not found', { status: 404 }));
    const route = `${url.pathname.slice(PORT_PREFIX.length)}${url.search}`;
    const stream = /\/watch$/.test(url.pathname);
    const body = typeof init.body === 'string' ? init.body : null;
    const admitted = this.o.limiter.begin(
      this.o.tenant,
      stream ? 'stream' : 'call'
    );
    if (!admitted.ok || (body !== null && body.length > MAX_FRAME_BODY))
      return Promise.resolve(
        Response.json(
          {
            error: {
              kind: 'messaging',
              code: 'limited',
              message: 'this agent is at its relay limit; retry shortly',
            },
          },
          {
            status: 429,
            headers: {
              'retry-after': String(admitted.ok ? 1 : admitted.retryAfterSec),
            },
          }
        )
      );
    if (body !== null && !this.o.limiter.bytes(this.o.tenant, body.length)) {
      admitted.done();
      return Promise.resolve(new Response('limited', { status: 429 }));
    }
    const id = randomBytes(16).toString('base64url');
    const signal = init.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = {
        stream,
        resolve,
        reject,
        timer: null,
        controller: null,
        done: admitted.done,
      };
      entry.timer = setTimeout(() => {
        this.finish(id);
        this.o.send({ t: 'cancel', id });
        reject(new TenantGone('no answer in time'));
      }, this.o.deadlineMs ?? DEADLINE_MS);
      this.pending.set(id, entry);
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          const p = this.pending.get(id)!;
          this.finish(id);
          this.o.send({ t: 'cancel', id });
          p.controller?.error(new Error('aborted'));
          reject(new Error('aborted'));
        },
        { once: true }
      );
      this.o.send({
        t: 'call',
        id,
        route,
        method: init.method ?? 'GET',
        headers: callHeaders(new Headers(init.headers)),
        body,
      });
    });
  };

  private finish(id: string): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    if (p.timer !== null) clearTimeout(p.timer);
    this.pending.delete(id);
    p.done();
  }

  /** An answer from the daemon; false when no call of this channel has its id. */
  receive(
    frame: Extract<DaemonToRelay, { t: 'result' | 'chunk' | 'end' }>
  ): boolean {
    const p = this.pending.get(frame.id);
    if (p === undefined) return false;
    if (frame.t === 'result') {
      if (p.timer !== null) clearTimeout(p.timer);
      p.timer = null;
      if (p.stream && frame.status === 200 && frame.body === null) {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            p.controller = controller;
          },
          cancel: () => {
            this.finish(frame.id);
            this.o.send({ t: 'cancel', id: frame.id });
          },
        });
        p.resolve(new Response(body, { status: 200, headers: frame.headers }));
      } else {
        this.finish(frame.id);
        p.resolve(
          new Response(frame.body, {
            status: frame.status,
            headers: frame.headers,
          })
        );
      }
      return true;
    }
    if (p.controller === null) return false;
    if (frame.t === 'chunk') {
      if (!this.o.limiter.bytes(this.o.tenant, frame.data.length)) {
        p.controller.error(new Error('over the relay byte limit'));
        this.finish(frame.id);
        this.o.send({ t: 'cancel', id: frame.id });
        return true;
      }
      p.controller.enqueue(new TextEncoder().encode(frame.data));
      return true;
    }
    p.controller.close();
    this.finish(frame.id);
    return true;
  }

  /** The connection is gone: every call still waiting fails. */
  close(): void {
    this.closed = true;
    for (const [id, p] of [...this.pending]) {
      this.finish(id);
      p.controller?.error(new TenantGone('disconnected'));
      p.reject(new TenantGone('disconnected'));
    }
  }
}

/** handleA2A's port for one tenant: HttpBridgePort over its channel. */
export function relayBridgePort(
  channel: TenantChannel,
  publicUrl: string
): HttpBridgePort {
  return new HttpBridgePort({
    daemonUrl: 'relay://tenant',
    hostToken: 'relay',
    publicUrl,
    fetchImpl: channel.fetch as typeof fetch,
  });
}
