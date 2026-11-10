import {
  CLOSE,
  daemonIdFor,
  fromBase64Url,
  isDaemonId,
  MAX_FRAME_BYTES,
  prefixSid,
  SID_BYTES,
  sidFromBytes,
  toHex,
} from '@dispatch/remote';
import type { DaemonControl } from '@dispatch/remote';
import type { Server, ServerWebSocket } from 'bun';

// The remote relay: a meeting point for a daemon that dials out and the
// phones paired with it, so a phone reaches a Mac with no VPN, no open port
// and nothing to set up on the network.
//
// It forwards bytes and reads only routing. A daemon signs in with its relay
// secret (the id it is reached at is a hash of that secret), and every phone
// that asks for that id becomes a session id on the daemon's one socket.
// What a phone and its daemon say to each other is end-to-end encrypted
// (@dispatch/remote's handshake), so the relay never holds a key that opens
// it. It keeps nothing on disk and nothing about a session once it ends.
//
// What it can see: which daemon ids are online and from which IP, when each
// phone connects and from which IP, and the size and timing of every frame.

interface DaemonData {
  role: 'daemon';
  ip: string;
  /** Null until the daemon has signed in. */
  id: string | null;
  authTimer: ReturnType<typeof setTimeout> | null;
}

interface PhoneData {
  role: 'phone';
  ip: string;
  daemonId: string;
  sid: string;
}

type SocketData = DaemonData | PhoneData;
type Socket = ServerWebSocket<SocketData>;

export interface RelayOptions {
  port?: number;
  hostname?: string;
  /** Phone sessions one daemon may hold open at once. */
  maxSessionsPerDaemon?: number;
  /** New connections one IP may open per minute, phones and daemons alike. */
  connectsPerMinute?: number;
  /** How long a daemon has to sign in after its socket opens. */
  authTimeoutMs?: number;
  /** Read the client IP from X-Forwarded-For. Only behind a proxy that sets
   *  it (Railway's does); otherwise any client could pick its own IP. */
  trustForwardedFor?: boolean;
  log?: (line: string) => void;
}

export interface Relay {
  port: number;
  url: string;
  stop(): void;
  /** Counts, for /health and tests. */
  stats(): { daemons: number; phones: number };
}

/** A fixed one-minute window per key. */
class ConnectLimiter {
  private readonly windows = new Map<
    string,
    { count: number; start: number }
  >();

  constructor(private readonly limit: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= 60_000) {
      if (this.windows.size > 50_000) this.windows.clear();
      this.windows.set(key, { count: 1, start: now });
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }
}

/** Bun's send result 0 means the frame was dropped, which would throw off
 *  the session's cipher counters, so the session has to end. */
function delivered(result: number): boolean {
  return result !== 0;
}

export function startRelay(options: RelayOptions = {}): Relay {
  const log = options.log ?? (() => {});
  const maxSessions = options.maxSessionsPerDaemon ?? 8;
  const limiter = new ConnectLimiter(options.connectsPerMinute ?? 60);
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;

  const daemons = new Map<string, Socket>();
  const phones = new Map<string, Socket>();
  const sessionsOf = new Map<string, Set<string>>();

  function sendControl(daemon: Socket, message: DaemonControl): void {
    daemon.send(JSON.stringify(message));
  }

  function closePhone(sid: string, code: number, reason: string): void {
    const phone = phones.get(sid);
    if (phone === undefined) return;
    forgetPhone(phone.data as PhoneData);
    phone.close(code, reason);
  }

  function forgetPhone(data: PhoneData): boolean {
    if (phones.get(data.sid)?.data !== data) return false;
    phones.delete(data.sid);
    sessionsOf.get(data.daemonId)?.delete(data.sid);
    return true;
  }

  function signIn(socket: Socket, data: DaemonData, text: string): void {
    let message: DaemonControl;
    try {
      message = JSON.parse(text) as DaemonControl;
    } catch {
      socket.close(CLOSE.badAuth, 'expected sign-in');
      return;
    }
    if (message.t !== 'auth' || message.v !== 1) {
      socket.close(CLOSE.badAuth, 'expected sign-in');
      return;
    }
    let secret: Uint8Array;
    try {
      secret = fromBase64Url(message.secret);
    } catch {
      socket.close(CLOSE.badAuth, 'bad secret');
      return;
    }
    if (secret.length !== 32) {
      socket.close(CLOSE.badAuth, 'bad secret');
      return;
    }
    if (data.authTimer !== null) clearTimeout(data.authTimer);
    data.authTimer = null;
    const id = daemonIdFor(secret);
    const previous = daemons.get(id);
    if (previous !== undefined && previous !== socket) {
      // A restarted daemon, or a second process for the same project: the
      // newest wins, and the old one's phones reconnect to it.
      (previous.data as DaemonData).id = null;
      previous.close(CLOSE.replaced, 'replaced');
      for (const sid of sessionsOf.get(id) ?? [])
        closePhone(sid, CLOSE.peerGone, 'daemon replaced');
    }
    data.id = id;
    daemons.set(id, socket);
    if (!sessionsOf.has(id)) sessionsOf.set(id, new Set());
    sendControl(socket, { t: 'ready', id });
    log(`daemon ${id.slice(0, 8)} online`);
  }

  function fromDaemon(data: DaemonData, message: string | Buffer): void {
    if (typeof message === 'string') {
      let control: DaemonControl;
      try {
        control = JSON.parse(message) as DaemonControl;
      } catch {
        return;
      }
      if (
        control.t === 'close' &&
        sessionsOf.get(data.id ?? '')?.has(control.sid) === true
      )
        closePhone(control.sid, CLOSE.peerGone, 'closed by daemon');
      return;
    }
    if (message.length < SID_BYTES) return;
    const sid = sidFromBytes(message);
    if (sessionsOf.get(data.id ?? '')?.has(sid) !== true) return;
    const phone = phones.get(sid);
    if (phone === undefined) return;
    if (!delivered(phone.sendBinary(message.subarray(SID_BYTES))))
      closePhone(sid, CLOSE.peerGone, 'backpressure');
  }

  function fromPhone(data: PhoneData, message: string | Buffer): void {
    if (typeof message === 'string') return;
    const daemon = daemons.get(data.daemonId);
    if (daemon === undefined) {
      closePhone(data.sid, CLOSE.daemonOffline, 'daemon offline');
      return;
    }
    if (!delivered(daemon.sendBinary(prefixSid(data.sid, message)))) {
      closePhone(data.sid, CLOSE.peerGone, 'backpressure');
      sendControl(daemon, { t: 'close', sid: data.sid });
    }
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? '0.0.0.0',
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          daemons: daemons.size,
          phones: phones.size,
        });
      }
      // Behind a proxy the peer is the proxy. Its own entry is the last one
      // in X-Forwarded-For: earlier entries are whatever the client sent.
      const forwarded =
        options.trustForwardedFor === true
          ? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
          : undefined;
      const ip = forwarded ?? srv.requestIP(req)?.address ?? 'unknown';
      if (
        url.pathname === '/v1/daemon' ||
        url.pathname.startsWith('/v1/phone/')
      ) {
        if (!limiter.allow(ip))
          return new Response('slow down', { status: 429 });
      }
      if (url.pathname === '/v1/daemon') {
        const data: DaemonData = {
          role: 'daemon',
          ip,
          id: null,
          authTimer: null,
        };
        return srv.upgrade(req, { data })
          ? undefined
          : new Response('expected websocket', { status: 400 });
      }
      const match = /^\/v1\/phone\/([^/]+)$/.exec(url.pathname);
      if (match !== null) {
        const daemonId = match[1] ?? '';
        if (!isDaemonId(daemonId))
          return new Response('not found', { status: 404 });
        const sid = toHex(crypto.getRandomValues(new Uint8Array(SID_BYTES)));
        const data: PhoneData = { role: 'phone', ip, daemonId, sid };
        return srv.upgrade(req, { data })
          ? undefined
          : new Response('expected websocket', { status: 400 });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES + SID_BYTES,
      idleTimeout: 120,
      sendPings: true,
      open(socket) {
        const data = socket.data;
        if (data.role === 'daemon') {
          data.authTimer = setTimeout(() => {
            if (data.id === null)
              socket.close(CLOSE.badAuth, 'sign-in timed out');
          }, authTimeoutMs);
          return;
        }
        const daemon = daemons.get(data.daemonId);
        // Upgraded first and closed with a code, so the app can tell "your
        // Mac is offline" from a network error.
        if (daemon === undefined) {
          socket.close(CLOSE.daemonOffline, 'daemon offline');
          return;
        }
        const sessions = sessionsOf.get(data.daemonId) ?? new Set<string>();
        if (sessions.size >= maxSessions) {
          socket.close(CLOSE.tooMany, 'too many sessions');
          return;
        }
        sessions.add(data.sid);
        sessionsOf.set(data.daemonId, sessions);
        phones.set(data.sid, socket);
        sendControl(daemon, { t: 'open', sid: data.sid });
      },
      message(socket, message) {
        const data = socket.data;
        if (data.role === 'daemon') {
          if (data.id === null) {
            if (typeof message === 'string') signIn(socket, data, message);
            else socket.close(CLOSE.badAuth, 'expected sign-in');
            return;
          }
          fromDaemon(data, message);
          return;
        }
        fromPhone(data, message);
      },
      close(socket) {
        const data = socket.data;
        if (data.role === 'phone') {
          if (!forgetPhone(data)) return;
          const daemon = daemons.get(data.daemonId);
          if (daemon !== undefined)
            sendControl(daemon, { t: 'close', sid: data.sid });
          return;
        }
        if (data.authTimer !== null) clearTimeout(data.authTimer);
        const id = data.id;
        if (id === null || daemons.get(id) !== socket) return;
        daemons.delete(id);
        for (const sid of [...(sessionsOf.get(id) ?? [])])
          closePhone(sid, CLOSE.daemonOffline, 'daemon offline');
        sessionsOf.delete(id);
        log(`daemon ${id.slice(0, 8)} offline`);
      },
    },
  });

  const port = server.port ?? 0;
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    stop: () => {
      void server.stop(true);
    },
    stats: () => ({ daemons: daemons.size, phones: phones.size }),
  };
}
