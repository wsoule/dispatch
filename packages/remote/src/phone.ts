import { utf8Decode, utf8Encode } from './bytes.js';
import type { DaemonFrame, PhoneFrame } from './frames.js';
import { decodeFrame, encodeFrame } from './frames.js';
import type { KeyPair, RandomBytes, Welcome } from './handshake.js';
import { defaultRandom, PhoneHandshake, SessionCipher } from './handshake.js';
import {
  binaryOf,
  CLOSE,
  jsonPayload,
  readPayload,
  sealedPayload,
  TAG,
} from './wire.js';

// The phone's end of a relayed session, shaped so @dispatch/client runs on it
// unchanged: `fetch` for every API call and `createSocket` for the event
// stream, both carried as tunnel frames to the daemon, which replays them
// against its own loopback API (packages/server/src/remote/). The relay in
// between sees ciphertext.
//
// One RemoteConnection is one paired daemon. It keeps itself connected with a
// capped backoff while started, and says where it stands through `onStatus`.

/** The parts of a WebSocket this needs; React Native's and Bun's both fit. */
export interface RelaySocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type RemoteStatus =
  | { kind: 'connecting' }
  | { kind: 'ready'; name: string; device: string }
  /** The relay is reachable but the daemon is not on it: the Mac is asleep,
   *  offline, or Dispatch is not running. */
  | { kind: 'offline' }
  /** The daemon refused this phone. Retrying will not help. */
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'stopped' };

export interface RemoteConnectionOptions {
  relay: string;
  daemonId: string;
  daemonKey: Uint8Array;
  phone: KeyPair;
  /** Present for the first connection after scanning a code. */
  pairing?: { offerId: string; code: Uint8Array; name: string };
  createWebSocket: (url: string) => RelaySocket;
  random?: RandomBytes;
  /** How long a request waits for the session before failing. */
  requestTimeoutMs?: number;
  /** Upper bound on the reconnect backoff. */
  maxBackoffMs?: number;
}

/** The subset of the DOM socket @dispatch/client's connectEvents uses. */
export interface TunnelSocket {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  close(): void;
}

interface Pending {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  socket: RelaySocket;
  cipher: SessionCipher | null;
  handshake: PhoneHandshake;
}

/** Statuses that a fresh body can never be given to `new Response`. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export class RemoteConnection {
  private status: RemoteStatus = { kind: 'stopped' };
  private readonly listeners = new Set<(status: RemoteStatus) => void>();
  private session: Session | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sockets = new Map<number, VirtualSocket>();
  private readonly waiters = new Set<() => void>();
  private pairing: RemoteConnectionOptions['pairing'];
  /** The daemon's ready, held until it answers our first frame (pairing). */
  private awaitingPairing: { name: string; device: string } | null = null;
  private started = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RemoteConnectionOptions) {
    this.pairing = options.pairing;
  }

  /** Where the session stands now. */
  current(): RemoteStatus {
    return this.status;
  }

  /** Hears every status change; returns the unsubscribe. */
  onStatus(listener: (status: RemoteStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.session?.socket.close(1000, 'stopped');
    this.teardown(new Error('disconnected'));
    this.setStatus({ kind: 'stopped' });
  }

  /** Reconnects now rather than after the backoff, e.g. on app foreground. */
  retryNow(): void {
    if (!this.started || this.status.kind === 'ready') return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.session?.socket.close(1000, 'retry');
    this.session = null;
    this.teardown(new Error('reconnecting'));
    this.open();
  }

  /** `fetch`, carried to the daemon. Only paths under /api/ are relayed. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      'dispatch-remote://daemon'
    );
    const path = `${url.pathname}${url.search}`;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      // The daemon decides who this phone is from the handshake; a header
      // credential would only be dropped there anyway.
      if (key !== 'authorization' && key !== 'cookie') headers[key] = value;
    });
    const body = await bodyBytes(init?.body);
    await this.whenReady();
    return await new Promise<Response>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('the daemon did not answer in time'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame({ t: 'req', id, method, path, headers }, body);
    });
  };

  /** A socket for @dispatch/client's connectEvents (`createSocket`). The URL
   *  is ignored past its path: there is one event stream per daemon. */
  readonly createSocket = (_url: string): TunnelSocket => {
    const id = this.nextId++;
    const socket = new VirtualSocket(() => {
      this.sockets.delete(id);
      if (this.status.kind === 'ready') this.sendFrame({ t: 'ws-close', id });
    });
    this.sockets.set(id, socket);
    void this.whenReady().then(
      () => {
        if (socket.isClosed()) return;
        this.sendFrame({ t: 'ws-open', id, path: '/ws' });
      },
      () => socket.fail()
    );
    return socket;
  };

  private setStatus(status: RemoteStatus): void {
    this.status = status;
    if (status.kind === 'ready') {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
    for (const listener of this.listeners) listener(status);
  }

  /** Resolves once ready; rejects after the request timeout, or at once when
   *  the connection was stopped or refused. */
  private async whenReady(): Promise<void> {
    if (this.status.kind === 'ready') return;
    if (!this.started) throw new Error('not connected');
    if (this.status.kind === 'refused')
      throw new Error(`the daemon refused this phone: ${this.status.reason}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(
          new Error(
            this.status.kind === 'offline'
              ? 'your Mac is offline'
              : 'could not reach the daemon'
          )
        );
      }, this.options.requestTimeoutMs ?? 30_000);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(wake);
    });
  }

  private open(): void {
    const handshake = new PhoneHandshake(
      this.options.phone,
      this.options.daemonKey,
      this.pairing ?? null,
      this.options.random ?? defaultRandom
    );
    const url = `${this.options.relay.replace(/\/+$/, '')}/v1/phone/${this.options.daemonId}`;
    const socket = this.options.createWebSocket(url);
    socket.binaryType = 'arraybuffer';
    const session: Session = { socket, cipher: null, handshake };
    this.session = session;
    this.setStatus({ kind: 'connecting' });

    socket.onopen = () => {
      send(socket, jsonPayload(TAG.hello, handshake.hello));
    };
    socket.onmessage = (event) => {
      if (this.session !== session) return;
      const bytes = binaryOf(event.data);
      if (bytes === null) return;
      try {
        this.receive(session, bytes);
      } catch (error) {
        // A frame that fails to open means tampering or a lost frame: the
        // only safe move is a new session.
        this.setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        socket.close(1000, 'bad frame');
      }
    };
    socket.onclose = (event) => {
      if (this.session !== session) return;
      this.session = null;
      this.teardown(new Error('connection to the daemon was lost'));
      if (this.status.kind === 'refused' || !this.started) return;
      if (event.code === CLOSE.daemonOffline)
        this.setStatus({ kind: 'offline' });
      else if (this.status.kind !== 'error')
        this.setStatus({ kind: 'error', message: 'disconnected' });
      this.scheduleRetry();
    };
    socket.onerror = () => {
      // onclose follows and decides what happens next.
    };
  }

  private scheduleRetry(): void {
    if (!this.started) return;
    const cap = this.options.maxBackoffMs ?? 30_000;
    const delay = Math.min(cap, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.open();
    }, delay);
  }

  private receive(session: Session, bytes: Uint8Array): void {
    const payload = readPayload(bytes);
    if (session.cipher === null) {
      if (payload.tag === TAG.welcome) {
        session.cipher = new SessionCipher(
          session.handshake.finish(payload.json as Welcome)
        );
        return;
      }
      if (payload.tag === TAG.reject) {
        const reason =
          (payload.json as { reason?: string } | null)?.reason ?? 'refused';
        this.setStatus({ kind: 'refused', reason });
        session.socket.close(1000, 'refused');
        return;
      }
      throw new Error('unexpected frame before the handshake finished');
    }
    if (payload.tag !== TAG.sealed) throw new Error('unexpected clear frame');
    const { header, body } = decodeFrame<DaemonFrame>(
      session.cipher.open(payload.body)
    );
    this.handle(header, body);
  }

  private handle(frame: DaemonFrame, body: Uint8Array): void {
    switch (frame.t) {
      case 'ready':
        // The first sealed frame proves the daemon. While pairing, the daemon
        // records this phone only once a sealed frame of ours proves we hold
        // the code, so send one and wait for its answer before calling the
        // phone paired; dropping the code any sooner could strand it.
        if (this.pairing !== undefined) {
          this.awaitingPairing = { name: frame.name, device: frame.device };
          this.sendFrame({ t: 'ping' });
          return;
        }
        this.becomeReady(frame.name, frame.device);
        return;
      case 'res': {
        const pending = this.pending.get(frame.id);
        if (pending === undefined) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(
          new Response(
            NULL_BODY_STATUSES.has(frame.status) ? null : copy(body),
            {
              status: frame.status,
              headers: frame.headers,
            }
          )
        );
        return;
      }
      case 'ws-msg':
        this.sockets.get(frame.id)?.deliver(utf8Decode(body));
        return;
      case 'ws-close':
        this.sockets.get(frame.id)?.fail();
        this.sockets.delete(frame.id);
        return;
      case 'error': {
        if (frame.id === null) return;
        const pending = this.pending.get(frame.id);
        if (pending !== undefined) {
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          pending.reject(new Error(frame.message));
        }
        return;
      }
      case 'pong': {
        const waiting = this.awaitingPairing;
        if (waiting === null) return;
        this.awaitingPairing = null;
        this.pairing = undefined;
        this.becomeReady(waiting.name, waiting.device);
        return;
      }
    }
  }

  private becomeReady(name: string, device: string): void {
    this.attempt = 0;
    // Sockets opened while connecting were waiting on ready.
    this.setStatus({ kind: 'ready', name, device });
  }

  private sendFrame(frame: PhoneFrame, body?: Uint8Array): void {
    const session = this.session;
    if (session?.cipher === null || session === null) {
      throw new Error('not connected');
    }
    send(
      session.socket,
      sealedPayload(session.cipher.seal(encodeFrame(frame, body)))
    );
  }

  /** Fails every request and event socket riding the session that ended. */
  private teardown(error: Error): void {
    this.awaitingPairing = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, socket] of this.sockets) socket.fail();
    this.sockets.clear();
  }
}

/** The event stream as connectEvents sees it: a message per ServerEvent. */
class VirtualSocket implements TunnelSocket {
  private readonly onMessage = new Set<(event: { data: unknown }) => void>();
  private readonly onEnd = new Set<() => void>();
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (type === 'message')
      this.onMessage.add(listener as (event: { data: unknown }) => void);
    else this.onEnd.add(listener as () => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  isClosed(): boolean {
    return this.closed;
  }

  deliver(text: string): void {
    if (this.closed) return;
    for (const listener of this.onMessage) listener({ data: text });
  }

  /** The far end went away: tell connectEvents, which reconnects. */
  fail(): void {
    if (this.closed) return;
    this.closed = true;
    // connectEvents registers one function for both close and error, so
    // the set holds it once and it runs once.
    for (const listener of this.onEnd) listener();
  }
}

function send(socket: RelaySocket, payload: Uint8Array): void {
  socket.send(copy(payload).buffer as ArrayBuffer);
}

// An exact-length copy: a subarray's .buffer is the whole parent buffer.
function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

async function bodyBytes(body: RequestInit['body']): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob)
    return new Uint8Array(await body.arrayBuffer());
  throw new Error('this request body cannot be sent from the phone yet');
}
