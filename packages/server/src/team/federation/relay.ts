import { signText } from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';

import { RELAY_DISCLOSURE } from './teamKeys.js';
import { TransportOffline } from './transport.js';
import type {
  FederationTransport,
  TransportHealth,
  Watermarks,
} from './transport.js';

// The relay transport (spec "Relay (F4)"): one WebSocket to the team's relay,
// URL-bound auth, request frames answered by id, and pushes that wake a pass.
// docs/specs/2026-10-05-sealed-relay-contract.md is the frame contract.

export { RELAY_DISCLOSURE };

/** What the relay's auth signature covers: the exact URL dialed. */
export const relayAuthText = (url: string, teamId: string, nonce: string) =>
  `dispatch-relay-v1\n${url}\n${teamId}\n${nonce}`;

export type RelayFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'auth'; replica: string; sig: string; keyOp?: LogEntry }
  | { t: 'ready' }
  | { t: 'refused'; reason: string }
  | { t: 'publish'; id: number; ops: LogEntry[] }
  | { t: 'stored'; re: number; through: number }
  | {
      t: 'pull';
      id: number;
      since: Record<string, number>;
      replicas?: string[];
    }
  | { t: 'ops'; re?: number; ops: LogEntry[]; more?: boolean }
  | { t: 'ack'; id: number; through: Record<string, number> }
  | { t: 'acknowledged'; re: number }
  | { t: 'error'; re: number; reason: string }
  | { t: 'presence'; online: { replica: string; since: string }[] };

// A request waits this long for its answer before the socket is dropped.
const REQUEST_MS = 15_000;
// Reconnect backoff, doubling from the first to the last.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Pull rounds one call follows `more` for.
const PULL_ROUNDS = 20;
// A publish frame carries at most this many entries and bytes (the contract).
const OPS_PER_FRAME = 1000;
const FRAME_BYTES = 4 * 1024 * 1024;
// A frame from the relay over this many characters closes the socket.
const MAX_INCOMING_CHARS = 16 * 1024 * 1024;

interface Waiter {
  resolve: (frame: RelayFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayDeps {
  /** The relay's base URL, as the roster's `transport` op names it. */
  url: string;
  teamId: string;
  replica: string;
  signPriv: string;
  /** This replica's key op, which carries its invite proof while pending. */
  keyOp: () => LogEntry | null;
  /** A push arrived: run a pass soon. */
  wake: () => void;
  now: () => Date;
  /** Tests only: sign the challenge for another URL than the one dialed. */
  signFor?: string;
  /** Tests only: entries per publish frame, in place of OPS_PER_FRAME. */
  opsPerFrame?: number;
}

/** A relay URL as it is dialed and signed: no trailing slash. */
const normalRelayUrl = (url: string): string => url.replace(/\/+$/, '');

/** Ops on the relay; every call made while it is unreachable throws
 *  TransportOffline, so the outbox waits (no fallback to git). */
export class RelayFederationTransport implements FederationTransport {
  readonly kind = 'relay' as const;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiter>();
  private online: { replica: string; since: string }[] = [];
  private lastError: string | null = null;
  private lastExchangeAt: string | null = null;
  private retryAt = 0;
  private backoff = 0;
  private pushes = 0;
  private closed = false;

  constructor(private readonly deps: RelayDeps) {}

  get url(): string {
    return this.deps.url;
  }

  async publish(ops: FederatedOp[]): Promise<void> {
    await this.upload(ops);
  }

  /** Stores entries (stubs too) on the relay, idempotent by (replica, seq),
   *  in frames of at most OPS_PER_FRAME entries and FRAME_BYTES; it stops at
   *  the first frame the relay stored only part of. */
  async upload(entries: readonly LogEntry[]): Promise<void> {
    const per = this.deps.opsPerFrame ?? OPS_PER_FRAME;
    let frame: LogEntry[] = [];
    let bytes = 0;
    const send = async (): Promise<void> => {
      if (frame.length === 0) return;
      const ops = frame;
      frame = [];
      bytes = 0;
      const reply = await this.request({ t: 'publish', id: 0, ops });
      if (reply.t !== 'stored')
        throw new TransportOffline('the relay stored nothing');
      const top = Math.max(...ops.map((e) => e.seq));
      if (reply.through < top)
        throw new TransportOffline(
          `the relay holds this machine's ops only through seq ${reply.through}`
        );
    };
    for (const e of entries) {
      const size = Buffer.byteLength(JSON.stringify(e));
      if (
        frame.length >= per ||
        (frame.length > 0 && bytes + size > FRAME_BYTES)
      )
        await send();
      frame.push(e);
      bytes += size;
    }
    await send();
  }

  async pull(since: Watermarks): Promise<LogEntry[]> {
    return this.pullFrom(Object.fromEntries(since));
  }

  async scan(replicas: readonly string[] | null): Promise<LogEntry[]> {
    return this.pullFrom({}, replicas === null ? undefined : [...replicas]);
  }

  stamp(): string {
    return String(this.pushes);
  }

  forgetScans(): void {}

  async ack(through: Watermarks): Promise<void> {
    const reply = await this.request({
      t: 'ack',
      id: 0,
      through: Object.fromEntries(through),
    });
    if (reply.t !== 'acknowledged')
      throw new TransportOffline('the relay did not acknowledge');
  }

  presence(): { replica: string; since: string }[] | null {
    return this.ws === null ? null : [...this.online];
  }

  health(): TransportHealth {
    return {
      kind: 'relay',
      lastExchangeAt: this.lastExchangeAt,
      lastError: this.lastError,
      unpublished: 0,
      sizeBytes: null,
      readBytes: 0,
      // The relay's own 30-day retention replaces git's pruning blockers.
      acks: {},
      url: this.deps.url,
    };
  }

  /** Drops the socket for good. */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.down('closed');
  }

  private async pullFrom(
    since: Record<string, number>,
    replicas?: string[]
  ): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    const marks = { ...since };
    for (let round = 0; round < PULL_ROUNDS; round++) {
      const reply = await this.request({
        t: 'pull',
        id: 0,
        since: marks,
        ...(replicas === undefined ? {} : { replicas }),
      });
      if (reply.t !== 'ops')
        throw new TransportOffline('the relay sent no ops');
      out.push(...reply.ops);
      for (const e of reply.ops)
        marks[e.replica] = Math.max(marks[e.replica] ?? 0, e.seq);
      if (reply.more !== true) break;
    }
    this.lastExchangeAt = this.deps.now().toISOString();
    return out;
  }

  // One request frame, answered by the frame that names its id.
  private async request(
    frame: Extract<RelayFrame, { id: number }>
  ): Promise<RelayFrame> {
    const ws = await this.socket();
    const id = this.nextId++;
    return await new Promise<RelayFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new TransportOffline('the relay did not answer'));
        ws.close();
      }, REQUEST_MS);
      this.waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...frame, id }));
    }).then((reply) => {
      if (reply.t === 'error') throw new TransportOffline(reply.reason);
      return reply;
    });
  }

  // The authenticated socket, connecting when there is none and the
  // backoff allows.
  private socket(): Promise<WebSocket> {
    if (this.ws !== null) return Promise.resolve(this.ws);
    if (this.closed)
      return Promise.reject(
        new TransportOffline('the relay transport is closed')
      );
    if (this.connecting !== null) return this.connecting;
    if (Date.now() < this.retryAt)
      return Promise.reject(
        new TransportOffline(this.lastError ?? 'the relay is unreachable')
      );
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private open(): Promise<WebSocket> {
    const { teamId, replica, signPriv } = this.deps;
    const url = normalRelayUrl(this.deps.url);
    const endpoint = `${url}/v1/teams/${teamId}`;
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const fail = (why: string): void => {
        this.lastError = why;
        this.backoff = Math.min(
          BACKOFF_MAX_MS,
          Math.max(BACKOFF_MIN_MS, this.backoff * 2)
        );
        this.retryAt = Date.now() + this.backoff;
        if (!settled) {
          settled = true;
          reject(new TransportOffline(why));
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(endpoint);
      } catch (err) {
        fail(`the relay is unreachable: ${(err as Error).message}`);
        return;
      }
      const timer = setTimeout(() => {
        fail('the relay did not answer');
        ws.close();
      }, REQUEST_MS);
      ws.onmessage = (ev) => {
        const frame = readFrame(ev.data);
        // A frame off the contract closes the socket, as the contract says.
        if (frame === null) {
          ws.close();
          return;
        }
        if (!settled && frame.t === 'challenge') {
          const keyOp = this.deps.keyOp();
          const sig = signText(
            signPriv,
            relayAuthText(this.deps.signFor ?? url, teamId, frame.nonce)
          );
          ws.send(
            JSON.stringify({
              t: 'auth',
              replica,
              sig,
              ...(keyOp === null ? {} : { keyOp }),
            })
          );
          return;
        }
        if (!settled && frame.t === 'refused') {
          clearTimeout(timer);
          fail(`refused: ${frame.reason}`);
          ws.close();
          return;
        }
        if (!settled && frame.t === 'ready') {
          clearTimeout(timer);
          settled = true;
          this.ws = ws;
          this.backoff = 0;
          this.lastError = null;
          resolve(ws);
          return;
        }
        if (settled) this.onFrame(frame);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.down('the relay closed the connection');
        fail(this.lastError ?? 'the relay closed the connection');
      };
      ws.onerror = () => {
        if (!settled) fail('the relay is unreachable');
      };
    });
  }

  // A frame on an authenticated socket: an answer, a push or presence.
  private onFrame(frame: RelayFrame): void {
    if (frame.t === 'presence') {
      this.online = frame.online;
      return;
    }
    if ('re' in frame && typeof frame.re === 'number') {
      const waiter = this.waiting.get(frame.re);
      if (waiter === undefined) return;
      this.waiting.delete(frame.re);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (frame.t === 'ops') {
      this.pushes += 1;
      this.deps.wake();
    }
  }

  // The socket is gone: every waiting call fails, and the next reconnects.
  private down(why: string): void {
    this.ws = null;
    this.online = [];
    this.lastError = why === 'closed' ? this.lastError : why;
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new TransportOffline(why));
      this.waiting.delete(id);
    }
  }
}

// A frame off the wire, or null; its ops are checked by the pass, not here.
function readFrame(data: unknown): RelayFrame | null {
  if (typeof data !== 'string' || data.length > MAX_INCOMING_CHARS) return null;
  try {
    const v = JSON.parse(data) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const t = (v as { t?: unknown }).t;
    if (typeof t !== 'string') return null;
    if ('ops' in v && !Array.isArray((v as { ops?: unknown }).ops)) return null;
    return v as RelayFrame;
  } catch {
    return null;
  }
}
