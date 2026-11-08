import {
  DaemonLink,
  type DeviceDirectory,
  generateKeyPair,
  type KeyPair,
  type LocalApi,
  type PairedDevice,
  type RelaySocket,
  RemoteConnection,
  type RemoteStatus,
} from '@dispatch/remote';
import { afterEach, describe, expect, test } from 'bun:test';

import { type Relay, startRelay } from '../src/relay.js';

// The whole path a phone takes: the app's RemoteConnection, this relay, and
// the daemon's DaemonLink, all real, over real sockets on loopback. Only the
// daemon's API is a stand-in (`local`), so what is checked is the transport:
// pairing, refusal, requests, the event stream and offline handling.

const ws = (url: string) => new WebSocket(url) as unknown as RelaySocket;

class MemoryDirectory implements DeviceDirectory {
  readonly devices: Array<PairedDevice & { key: string }> = [];
  readonly offers = new Map<string, Uint8Array>();

  find(publicKey: Uint8Array): PairedDevice | null {
    const key = Buffer.from(publicKey).toString('hex');
    return this.devices.find((d) => d.key === key) ?? null;
  }

  offerCode(offerId: string): Uint8Array | null {
    return this.offers.get(offerId) ?? null;
  }

  completePairing(
    offerId: string,
    publicKey: Uint8Array,
    name: string,
    deviceId: string
  ): PairedDevice | null {
    if (!this.offers.delete(offerId)) return null;
    const device = {
      id: deviceId,
      name,
      key: Buffer.from(publicKey).toString('hex'),
    };
    this.devices.push(device);
    return { id: device.id, name: device.name };
  }
}

/** A daemon API that echoes and can push events. */
function fakeApi() {
  const streams = new Set<(text: string) => void>();
  const seen: Array<{
    deviceId: string;
    method: string;
    path: string;
    body: string;
    headers: Record<string, string>;
  }> = [];
  const local: LocalApi = {
    request: (deviceId, req) => {
      seen.push({
        deviceId,
        method: req.method,
        path: req.path,
        body: new TextDecoder().decode(req.body),
        headers: req.headers,
      });
      if (req.path === '/api/empty')
        return Promise.resolve({
          status: 204,
          headers: {},
          body: new Uint8Array(),
        });
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(
          JSON.stringify({ path: req.path, deviceId })
        ),
      });
    },
    openEvents: (_deviceId, onMessage, onClose) => {
      streams.add(onMessage);
      return {
        close: () => {
          streams.delete(onMessage);
          onClose();
        },
      };
    },
  };
  return {
    local,
    seen,
    push: (text: string) => {
      for (const s of streams) s(text);
    },
    streams,
  };
}

function waitFor(
  conn: RemoteConnection,
  kind: RemoteStatus['kind']
): Promise<RemoteStatus> {
  return new Promise<RemoteStatus>((resolve, reject) => {
    if (conn.current().kind === kind) return resolve(conn.current());
    const timer = setTimeout(
      () =>
        reject(
          new Error(`timed out waiting for ${kind}, at ${conn.current().kind}`)
        ),
      5000
    );
    const off = conn.onStatus((s) => {
      if (s.kind === kind) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

async function setup(): Promise<{
  relay: Relay;
  link: DaemonLink;
  daemonKey: KeyPair;
  directory: MemoryDirectory;
  api: ReturnType<typeof fakeApi>;
  daemonId: string;
}> {
  const relay = startRelay({ hostname: '127.0.0.1' });
  cleanup.push(() => relay.stop());
  const daemonKey = generateKeyPair();
  const directory = new MemoryDirectory();
  const api = fakeApi();
  const link = new DaemonLink({
    relay: relay.url,
    secret: crypto.getRandomValues(new Uint8Array(32)),
    key: daemonKey,
    name: 'Test Mac',
    devices: directory,
    local: api.local,
    createWebSocket: ws,
  });
  cleanup.push(() => link.stop());
  const connected = new Promise<string>((resolve) => {
    link.onStatus((s) => {
      if (s.kind === 'connected') resolve(s.daemonId);
    });
  });
  link.start();
  const daemonId = await connected;
  return { relay, link, daemonKey, directory, api, daemonId };
}

function phone(
  relay: Relay,
  daemonId: string,
  daemonKey: KeyPair,
  key: KeyPair,
  pairing?: { offerId: string; code: Uint8Array; name: string }
): RemoteConnection {
  const conn = new RemoteConnection({
    relay: relay.url,
    daemonId,
    daemonKey: daemonKey.publicKey,
    phone: key,
    ...(pairing === undefined ? {} : { pairing }),
    createWebSocket: ws,
    requestTimeoutMs: 3000,
    maxBackoffMs: 200,
  });
  cleanup.push(() => conn.stop());
  return conn;
}

describe('remote relay', () => {
  test('a phone pairs with the code, then reaches the API and events', async () => {
    const { relay, daemonKey, directory, api, daemonId } = await setup();
    const code = crypto.getRandomValues(new Uint8Array(32));
    directory.offers.set('0123456789abcdef', code);
    const key = generateKeyPair();
    const conn = phone(relay, daemonId, daemonKey, key, {
      offerId: '0123456789abcdef',
      code,
      name: "Striker's iPhone",
    });
    conn.start();
    const ready = await waitFor(conn, 'ready');
    expect(ready).toMatchObject({ kind: 'ready', name: 'Test Mac' });

    const res = await conn.fetch('dispatch-remote://daemon/api/runs?x=1', {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        authorization: 'Bearer stolen',
        'content-type': 'application/json',
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; deviceId: string };
    expect(json.path).toBe('/api/runs?x=1');
    expect(directory.devices).toHaveLength(1);
    expect(directory.devices[0]?.name).toBe("Striker's iPhone");
    expect(json.deviceId).toBe(directory.devices[0]?.id ?? '');
    expect(api.seen[0]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    // The phone's own authorization header never reaches the API.
    expect(api.seen[0]?.headers.authorization).toBeUndefined();
    expect(api.seen[0]?.headers['content-type']).toBe('application/json');
    expect(directory.offers.size).toBe(0);

    const empty = await conn.fetch('/api/empty');
    expect(empty.status).toBe(204);

    const received: string[] = [];
    const socket = conn.createSocket('ignored');
    socket.addEventListener('message', (event) =>
      received.push(String(event.data))
    );
    await waitUntil(() => api.streams.size === 1);
    api.push('{"type":"run.changed"}');
    await waitUntil(() => received.length === 1);
    expect(received).toEqual(['{"type":"run.changed"}']);
    socket.close();
    await waitUntil(() => api.streams.size === 0);
  });

  test('the same phone reconnects later without a code', async () => {
    const { relay, daemonKey, directory, daemonId } = await setup();
    const code = crypto.getRandomValues(new Uint8Array(32));
    directory.offers.set('0123456789abcdef', code);
    const key = generateKeyPair();
    const first = phone(relay, daemonId, daemonKey, key, {
      offerId: '0123456789abcdef',
      code,
      name: 'iPhone',
    });
    first.start();
    await waitFor(first, 'ready');
    await first.fetch('/api/health');
    first.stop();

    const again = phone(relay, daemonId, daemonKey, key);
    again.start();
    await waitFor(again, 'ready');
    expect((await again.fetch('/api/health')).status).toBe(200);
  });

  test('a wrong code never pairs', async () => {
    const { relay, daemonKey, directory, daemonId } = await setup();
    directory.offers.set(
      '0123456789abcdef',
      crypto.getRandomValues(new Uint8Array(32))
    );
    const conn = phone(relay, daemonId, daemonKey, generateKeyPair(), {
      offerId: '0123456789abcdef',
      code: crypto.getRandomValues(new Uint8Array(32)),
      name: 'iPhone',
    });
    conn.start();
    await waitFor(conn, 'error');
    expect(directory.devices).toHaveLength(0);
    // The offer survives a failed guess for the real phone to use.
    expect(directory.offers.size).toBe(1);
  });

  test('an unpaired phone is refused', async () => {
    const { relay, daemonKey, daemonId } = await setup();
    const conn = phone(relay, daemonId, daemonKey, generateKeyPair());
    conn.start();
    const refused = await waitFor(conn, 'refused');
    expect(refused).toEqual({ kind: 'refused', reason: 'unknown-device' });
    await expect(conn.fetch('/api/health')).rejects.toThrow('refused');
  });

  test('a phone asking for an offline daemon hears it is offline', async () => {
    const relay = startRelay({ hostname: '127.0.0.1' });
    cleanup.push(() => relay.stop());
    const conn = phone(
      relay,
      'a'.repeat(32),
      generateKeyPair(),
      generateKeyPair()
    );
    conn.start();
    await waitFor(conn, 'offline');
  });

  test('only API paths are relayed', async () => {
    const { relay, daemonKey, directory, daemonId } = await setup();
    const code = crypto.getRandomValues(new Uint8Array(32));
    directory.offers.set('0123456789abcdef', code);
    const conn = phone(relay, daemonId, daemonKey, generateKeyPair(), {
      offerId: '0123456789abcdef',
      code,
      name: 'iPhone',
    });
    conn.start();
    await waitFor(conn, 'ready');
    await expect(conn.fetch('/preview/run-1/')).rejects.toThrow('only the API');
    await expect(conn.fetch('/api/../index.html')).rejects.toThrow();
  });

  test('a daemon that drops takes its phones offline, and they come back', async () => {
    const { relay, link, daemonKey, directory, daemonId } = await setup();
    const code = crypto.getRandomValues(new Uint8Array(32));
    directory.offers.set('0123456789abcdef', code);
    const conn = phone(relay, daemonId, daemonKey, generateKeyPair(), {
      offerId: '0123456789abcdef',
      code,
      name: 'iPhone',
    });
    conn.start();
    await waitFor(conn, 'ready');
    await conn.fetch('/api/health');
    link.stop();
    await waitUntil(() => conn.current().kind !== 'ready');
    link.start();
    await waitFor(conn, 'ready');
    expect((await conn.fetch('/api/health')).status).toBe(200);
  });

  test('a daemon cannot sign in without a valid secret', async () => {
    const relay = startRelay({ hostname: '127.0.0.1', authTimeoutMs: 200 });
    cleanup.push(() => relay.stop());
    const socket = new WebSocket(`${relay.url}/v1/daemon`);
    const code = await new Promise<number>((resolve) => {
      socket.onopen = () =>
        socket.send(JSON.stringify({ t: 'auth', v: 1, secret: 'short' }));
      socket.onclose = (event) => resolve(event.code);
    });
    expect(code).toBe(4401);
    const silent = new WebSocket(`${relay.url}/v1/daemon`);
    const timedOut = await new Promise<number>((resolve) => {
      silent.onclose = (event) => resolve(event.code);
    });
    expect(timedOut).toBe(4401);
  });
});
