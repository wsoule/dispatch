import { bytesEqual, toBase64Url, toHex, utf8Encode } from './bytes.js';
import type { DaemonFrame, PhoneFrame } from './frames.js';
import { decodeFrame, encodeFrame } from './frames.js';
import type { KeyPair, ParsedHello, RandomBytes, Reject } from './handshake.js';
import {
  answerHello,
  defaultRandom,
  parseHello,
  SessionCipher,
} from './handshake.js';
import type { RelaySocket } from './phone.js';
import {
  binaryOf,
  CLOSE,
  jsonPayload,
  prefixSid,
  readPayload,
  sealedPayload,
  SID_BYTES,
  sidFromBytes,
  TAG,
} from './wire.js';
import type { DaemonControl } from './wire.js';

// The daemon's end of the relay: one outbound WebSocket that every paired
// phone's session is multiplexed over. The daemon never listens for phones.
// It dials the relay, signs in with its relay secret, and the relay hands it
// each phone that asks for it as a session id. Per session it runs the
// handshake (handshake.ts), then turns each tunnel frame into a call against
// its own API through `local`, which the server wires to its loopback
// listener with a credential that speaks for the operator at the decide tier.

/** A phone this daemon has paired, as the server keeps it. */
export interface PairedDevice {
  id: string;
  name: string;
}

/** The server's device list and pending pairing offers. */
export interface DeviceDirectory {
  /** The paired device holding this static key, if any. */
  find(publicKey: Uint8Array): PairedDevice | null;
  /** The code of a live, unused offer, or null when it expired or was used. */
  offerCode(offerId: string): Uint8Array | null;
  /** Burns the offer and records the phone. Called once the phone has proved
   *  it holds the code, never on the hello alone. */
  completePairing(
    offerId: string,
    publicKey: Uint8Array,
    name: string,
    deviceId: string
  ): PairedDevice | null;
  /** A session for this device just became ready. */
  seen?(deviceId: string): void;
}

/** One HTTP exchange against the daemon's own API. */
export interface LocalRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface LocalResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** How a relayed frame reaches the daemon's API. */
export interface LocalApi {
  request(deviceId: string, request: LocalRequest): Promise<LocalResponse>;
  /** Opens the event stream for a device; `onMessage` gets each ServerEvent
   *  as JSON text, `onClose` once when it ends. */
  openEvents(
    deviceId: string,
    onMessage: (text: string) => void,
    onClose: () => void
  ): { close(): void };
}

interface DaemonLinkOptions {
  relay: string;
  secret: Uint8Array;
  key: KeyPair;
  /** What phones list this daemon as. */
  name: string;
  devices: DeviceDirectory;
  local: LocalApi;
  createWebSocket: (url: string) => RelaySocket;
  random?: RandomBytes;
  log?: (message: string) => void;
  maxBackoffMs?: number;
}

export type DaemonLinkStatus =
  | { kind: 'stopped' }
  | { kind: 'connecting' }
  | { kind: 'connected'; daemonId: string; sessions: number }
  | { kind: 'error'; message: string };

interface DaemonSession {
  sid: string;
  cipher: SessionCipher;
  /** Set once the phone is known: at once for a paired one, after its first
   *  sealed frame for one that is pairing. */
  device: PairedDevice | null;
  pending: {
    offerId: string;
    publicKey: Uint8Array;
    name: string;
    deviceId: string;
  } | null;
  events: Map<number, { close(): void }>;
}

/** Paths a phone may reach: the API and the event stream, nothing served
 *  statically, nothing proxied (no previews). */
function phoneMayReach(path: string): boolean {
  return path.startsWith('/api/') && !path.includes('..');
}

export class DaemonLink {
  private socket: RelaySocket | null = null;
  private readonly sessions = new Map<string, DaemonSession>();
  private status: DaemonLinkStatus = { kind: 'stopped' };
  private started = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: DaemonLinkStatus) => void>();

  constructor(private readonly options: DaemonLinkOptions) {}

  current(): DaemonLinkStatus {
    return this.status;
  }

  onStatus(listener: (status: DaemonLinkStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'stopped');
    this.dropAllSessions();
    this.setStatus({ kind: 'stopped' });
  }

  /** Ends every session for one device, after it is unpaired. */
  disconnectDevice(deviceId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.device?.id === deviceId) this.endSession(session, true);
    }
  }

  private setStatus(status: DaemonLinkStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  private connect(): void {
    const url = `${this.options.relay.replace(/\/+$/, '')}/v1/daemon`;
    const socket = this.options.createWebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus({ kind: 'connecting' });

    socket.onopen = () => {
      const auth: DaemonControl = {
        t: 'auth',
        v: 1,
        secret: toBase64Url(this.options.secret),
      };
      socket.send(JSON.stringify(auth));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const bytes = binaryOf(event.data);
      if (bytes === null) {
        if (typeof event.data === 'string') this.control(event.data);
        return;
      }
      if (bytes.length < SID_BYTES) return;
      const session = this.sessions.get(sidFromBytes(bytes));
      const payload = bytes.subarray(SID_BYTES);
      if (session === undefined) this.hello(sidFromBytes(bytes), payload);
      else this.sealed(session, payload);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropAllSessions();
      if (!this.started) return;
      this.setStatus({
        kind: 'error',
        message:
          event.code === CLOSE.replaced
            ? 'another Dispatch on this machine took over the relay link'
            : event.code === CLOSE.badAuth
              ? 'the relay refused this daemon'
              : 'lost the connection to the relay',
      });
      this.scheduleRetry(event.code === CLOSE.replaced ? 60_000 : undefined);
    };
    socket.onerror = () => {};
  }

  private scheduleRetry(minimum?: number): void {
    const cap = this.options.maxBackoffMs ?? 60_000;
    const delay = Math.max(
      minimum ?? 0,
      Math.min(cap, 1000 * 2 ** Math.min(this.attempt, 6))
    );
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private control(text: string): void {
    let message: DaemonControl;
    try {
      message = JSON.parse(text) as DaemonControl;
    } catch {
      return;
    }
    if (message.t === 'ready') {
      this.attempt = 0;
      this.setStatus({
        kind: 'connected',
        daemonId: message.id,
        sessions: this.sessions.size,
      });
      return;
    }
    if (message.t === 'close') {
      const session = this.sessions.get(message.sid);
      if (session !== undefined) this.endSession(session, false);
    }
    // `open` needs nothing: a session starts with the phone's hello.
  }

  private sendControl(message: DaemonControl): void {
    this.socket?.send(JSON.stringify(message));
  }

  private sendRaw(sid: string, payload: Uint8Array): void {
    this.socket?.send(Uint8Array.from(prefixSid(sid, payload)).buffer);
  }

  private reject(sid: string, reason: Reject['reason']): void {
    this.sendRaw(sid, jsonPayload(TAG.reject, { t: 'reject', reason }));
    this.sendControl({ t: 'close', sid });
  }

  /** A new session's first payload must be a hello. */
  private hello(sid: string, payload: Uint8Array): void {
    const { tag, json } = readPayload(payload);
    const hello: ParsedHello | null =
      tag === TAG.hello ? parseHello(json) : null;
    if (hello === null) {
      this.reject(sid, 'malformed');
      return;
    }
    if (!bytesEqual(hello.expectedDaemon, this.options.key.publicKey)) {
      this.reject(sid, 'wrong-daemon');
      return;
    }
    const known = this.options.devices.find(hello.phoneStatic);
    let psk: Uint8Array | null = null;
    let pending: DaemonSession['pending'] = null;
    if (known === null) {
      if (hello.pair === null) {
        this.reject(sid, 'unknown-device');
        return;
      }
      psk = this.options.devices.offerCode(hello.pair);
      if (psk === null) {
        this.reject(sid, 'pairing-expired');
        return;
      }
      pending = {
        offerId: hello.pair,
        publicKey: hello.phoneStatic,
        name: hello.name ?? 'iPhone',
        deviceId: toHex((this.options.random ?? defaultRandom)(8)),
      };
    }
    const { welcome, keys } = answerHello(
      this.options.key,
      hello,
      psk,
      this.options.random ?? defaultRandom
    );
    const session: DaemonSession = {
      sid,
      cipher: new SessionCipher(keys),
      device: known,
      pending,
      events: new Map(),
    };
    this.sessions.set(sid, session);
    this.sendRaw(sid, jsonPayload(TAG.welcome, welcome));
    // Sent at once, even while pairing: a phone holding the wrong code cannot
    // open it, and one holding the right code answers with a sealed frame,
    // which is what completes the pairing below.
    this.send(session, {
      t: 'ready',
      name: this.options.name,
      device: known?.id ?? pending?.deviceId ?? '',
    });
    if (known !== null) this.options.devices.seen?.(known.id);
    this.reportSessions();
  }

  private sealed(session: DaemonSession, payload: Uint8Array): void {
    const { tag, body } = readPayload(payload);
    let frame: { header: PhoneFrame; body: Uint8Array };
    try {
      if (tag !== TAG.sealed) throw new Error('clear frame mid-session');
      frame = decodeFrame<PhoneFrame>(session.cipher.open(body));
    } catch {
      // Wrong key (a pairing phone without the code) or a tampered frame.
      this.endSession(session, true);
      return;
    }
    if (session.device === null) {
      const p = session.pending;
      const device =
        p === null
          ? null
          : this.options.devices.completePairing(
              p.offerId,
              p.publicKey,
              p.name,
              p.deviceId
            );
      if (device === null) {
        this.endSession(session, true);
        return;
      }
      session.device = device;
      session.pending = null;
      this.options.log?.(`dispatchd: paired ${device.name}`);
    }
    this.frame(session, session.device, frame.header, frame.body);
  }

  private frame(
    session: DaemonSession,
    device: PairedDevice,
    header: PhoneFrame,
    body: Uint8Array
  ): void {
    switch (header.t) {
      case 'ping':
        this.send(session, { t: 'pong' });
        return;
      case 'req': {
        if (!phoneMayReach(header.path)) {
          this.send(session, {
            t: 'error',
            id: header.id,
            message: 'only the API is reachable from a phone',
          });
          return;
        }
        this.options.local
          .request(device.id, {
            method: header.method,
            path: header.path,
            headers: header.headers,
            body,
          })
          .then(
            (res) => {
              this.send(
                session,
                {
                  t: 'res',
                  id: header.id,
                  status: res.status,
                  headers: res.headers,
                },
                res.body
              );
            },
            (error: unknown) => {
              this.send(session, {
                t: 'error',
                id: header.id,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          );
        return;
      }
      case 'ws-open': {
        if (header.path !== '/ws' || session.events.has(header.id)) return;
        const handle = this.options.local.openEvents(
          device.id,
          (text) =>
            this.send(
              session,
              { t: 'ws-msg', id: header.id },
              utf8Encode(text)
            ),
          () => {
            if (session.events.delete(header.id))
              this.send(session, { t: 'ws-close', id: header.id });
          }
        );
        session.events.set(header.id, handle);
        return;
      }
      case 'ws-close': {
        const handle = session.events.get(header.id);
        session.events.delete(header.id);
        handle?.close();
        return;
      }
    }
  }

  private send(
    session: DaemonSession,
    frame: DaemonFrame,
    body?: Uint8Array
  ): void {
    if (this.sessions.get(session.sid) !== session) return;
    this.sendRaw(
      session.sid,
      sealedPayload(session.cipher.seal(encodeFrame(frame, body)))
    );
  }

  private endSession(session: DaemonSession, tellRelay: boolean): void {
    if (this.sessions.get(session.sid) !== session) return;
    this.sessions.delete(session.sid);
    for (const handle of session.events.values()) handle.close();
    session.events.clear();
    if (tellRelay) this.sendControl({ t: 'close', sid: session.sid });
    this.reportSessions();
  }

  private dropAllSessions(): void {
    for (const session of [...this.sessions.values()])
      this.endSession(session, false);
  }

  private reportSessions(): void {
    if (this.status.kind === 'connected')
      this.setStatus({ ...this.status, sessions: this.sessions.size });
  }
}
