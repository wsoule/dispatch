import {
  daemonIdFor,
  DaemonLink,
  type DaemonLinkStatus,
  type DeviceDirectory,
  generateKeyPair,
  type LocalApi,
  type LocalRequest,
  type LocalResponse,
  type PairedDevice,
  pairingUrl,
  publicKeyOf,
  type RelaySocket,
} from '@dispatch/remote';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { type OperatorDeviceCredentials, sha256 } from '../identity.js';
import type { RemoteState, RemoteStore, StoredDevice } from './store.js';

// Remote access: a paired phone reaching this daemon through the relay, with
// no VPN and no open port (see docs/specs/2026-11-06-remote-access-design.md).
//
// The daemon dials the relay only while a phone is paired or a pairing code
// is live. A phone never holds a daemon token: each session it opens is
// replayed here against the daemon's own loopback API with a credential that
// exists only in this process, minted per device at boot. That credential
// speaks for the operator at the decide tier, so a phone can answer gates,
// cancel runs and approve merges, but every operator-tier route (a shell,
// file writes, issuing credentials, pairing another phone) answers 403.

/** The hosted relay (apps/remote-relay). */
const DEFAULT_REMOTE_RELAY = 'wss://remote.dispatch.foo';

/** DISPATCH_REMOTE_RELAY when set, else the hosted relay. */
export function relayFromEnv(value: string | undefined): string {
  return value === undefined || value.trim() === ''
    ? DEFAULT_REMOTE_RELAY
    : value.trim();
}

/** How long a pairing code shown as a QR code stays usable. */
const OFFER_TTL_MS = 10 * 60_000;

/** Request headers a phone may set. Everything else, `authorization` and
 *  `cookie` above all, is dropped before the request reaches the API. */
const FORWARDED_HEADERS = new Set([
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
]);

interface RemoteDeviceSummary {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  relay: string;
  link: DaemonLinkStatus;
  devices: RemoteDeviceSummary[];
  /** When the live pairing code expires, or null when none is live. */
  offerExpiresAt: string | null;
}

export interface RemoteAccessOptions {
  store: RemoteStore;
  /** wss:// URL of the relay. */
  relay: string;
  /** What the phone lists this daemon as. */
  name: string;
  /** False with DISPATCH_REMOTE=off: nothing dials out, pairing refuses. */
  enabled: boolean;
  createWebSocket?: (url: string) => RelaySocket;
  now?: () => Date;
  log?: (line: string) => void;
}

interface Offer {
  id: string;
  code: Uint8Array;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteAccess
  implements OperatorDeviceCredentials, DeviceDirectory
{
  private state: RemoteState | null;
  private readonly credentials = new Map<
    string,
    { token: string; digest: Buffer }
  >();
  private offer: Offer | null = null;
  private link: DaemonLink | null = null;
  private port: number | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: RemoteAccessOptions) {
    this.state = options.store.load();
    this.now = options.now ?? (() => new Date());
  }

  // ---- OperatorDeviceCredentials -------------------------------------------

  matches(digest: Buffer): boolean {
    let found = false;
    // Every entry is compared, so the time taken does not say which matched.
    for (const entry of this.credentials.values()) {
      if (timingSafeEqual(digest, entry.digest)) found = true;
    }
    return found;
  }

  // ---- DeviceDirectory -------------------------------------------------------

  find(publicKey: Uint8Array): PairedDevice | null {
    const device = this.state?.devices.find((d) =>
      sameKey(d.publicKey, publicKey)
    );
    return device === undefined ? null : { id: device.id, name: device.name };
  }

  offerCode(offerId: string): Uint8Array | null {
    const offer = this.liveOffer();
    return offer !== null && offer.id === offerId ? offer.code : null;
  }

  completePairing(
    offerId: string,
    publicKey: Uint8Array,
    name: string,
    deviceId: string
  ): PairedDevice | null {
    const offer = this.liveOffer();
    if (offer === null || offer.id !== offerId || this.state === null)
      return null;
    this.clearOffer();
    const existing = this.find(publicKey);
    if (existing !== null) return existing;
    const at = this.now().toISOString();
    const device: StoredDevice = {
      id: deviceId,
      name: cleanName(name),
      publicKey: Uint8Array.from(publicKey),
      pairedAt: at,
      lastSeenAt: at,
    };
    this.state.devices.push(device);
    this.save();
    return { id: device.id, name: device.name };
  }

  seen(deviceId: string): void {
    const device = this.state?.devices.find((d) => d.id === deviceId);
    if (device === undefined) return;
    device.lastSeenAt = this.now().toISOString();
    this.save();
  }

  // ---- The service -----------------------------------------------------------

  /** Once the API listens on `port`. Dials the relay if a phone is paired. */
  start(port: number): void {
    this.port = port;
    this.syncLink();
  }

  stop(): void {
    this.clearOffer();
    this.link?.stop();
    this.link = null;
    this.port = null;
  }

  status(): RemoteAccessStatus {
    return {
      enabled: this.options.enabled,
      relay: this.options.relay,
      link: this.link?.current() ?? { kind: 'stopped' },
      devices: (this.state?.devices ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
      })),
      offerExpiresAt:
        this.liveOffer() === null
          ? null
          : new Date(this.offer?.expiresAt ?? 0).toISOString(),
    };
  }

  /** A fresh pairing code as the URL a QR code carries. Replaces any live
   *  one, so only the code on screen now can pair. */
  createOffer(): { url: string; expiresAt: string } | { error: string } {
    if (!this.options.enabled)
      return {
        error: 'remote access is off on this daemon (DISPATCH_REMOTE=off)',
      };
    if (this.port === null) return { error: 'the daemon is still starting' };
    const state = this.ensureState();
    this.clearOffer();
    const expiresAt = this.now().getTime() + OFFER_TTL_MS;
    const offer: Offer = {
      id: randomBytes(8).toString('hex'),
      code: new Uint8Array(randomBytes(32)),
      expiresAt,
      timer: setTimeout(() => {
        if (this.offer === offer) {
          this.offer = null;
          this.syncLink();
        }
      }, OFFER_TTL_MS),
    };
    offer.timer.unref?.();
    this.offer = offer;
    this.syncLink();
    return {
      url: pairingUrl({
        relay: this.options.relay,
        daemonId: daemonIdFor(state.secret),
        daemonKey: publicKeyOf(state.secretKey),
        offerId: offer.id,
        code: offer.code,
        name: this.options.name,
      }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Unpairs a phone and ends its sessions. False when no such device. */
  removeDevice(id: string): boolean {
    const devices = this.state?.devices ?? [];
    const index = devices.findIndex((d) => d.id === id);
    if (index === -1) return false;
    devices.splice(index, 1);
    this.save();
    this.credentials.delete(id);
    this.link?.disconnectDevice(id);
    this.syncLink();
    return true;
  }

  // ---- Internals -------------------------------------------------------------

  private liveOffer(): Offer | null {
    if (this.offer === null) return null;
    if (this.now().getTime() >= this.offer.expiresAt) {
      this.clearOffer();
      return null;
    }
    return this.offer;
  }

  private clearOffer(): void {
    if (this.offer !== null) clearTimeout(this.offer.timer);
    this.offer = null;
  }

  private ensureState(): RemoteState {
    if (this.state !== null) return this.state;
    this.state = {
      secret: new Uint8Array(randomBytes(32)),
      secretKey: generateKeyPair().secretKey,
      devices: [],
    };
    this.save();
    return this.state;
  }

  private save(): void {
    if (this.state !== null) this.options.store.save(this.state);
  }

  /** Dial the relay while anyone could use it; hang up when nobody could. */
  private syncLink(): void {
    const wanted =
      this.options.enabled &&
      this.port !== null &&
      this.state !== null &&
      (this.state.devices.length > 0 || this.offer !== null);
    if (!wanted) {
      this.link?.stop();
      this.link = null;
      return;
    }
    if (this.link !== null || this.state === null || this.port === null) return;
    const state = this.state;
    this.link = new DaemonLink({
      relay: this.options.relay,
      secret: state.secret,
      key: {
        secretKey: state.secretKey,
        publicKey: publicKeyOf(state.secretKey),
      },
      name: this.options.name,
      devices: this,
      local: loopbackApi(this.port, (deviceId) => this.credentialFor(deviceId)),
      createWebSocket:
        this.options.createWebSocket ??
        ((url) => new WebSocket(url) as unknown as RelaySocket),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    });
    this.link.start();
  }

  private credentialFor(deviceId: string): string | null {
    if (this.state?.devices.some((d) => d.id === deviceId) !== true)
      return null;
    const existing = this.credentials.get(deviceId);
    if (existing !== undefined) return existing.token;
    const token = `dsr_${randomBytes(32).toString('hex')}`;
    this.credentials.set(deviceId, { token, digest: sha256(token) });
    return token;
  }
}

/** The relay's requests, replayed against this daemon's own listener. */
function loopbackApi(
  port: number,
  credentialFor: (deviceId: string) => string | null
): LocalApi {
  const base = `http://127.0.0.1:${port}`;
  return {
    async request(deviceId: string, req: LocalRequest): Promise<LocalResponse> {
      const token = credentialFor(deviceId);
      if (token === null)
        return textResponse(401, 'this device is no longer paired');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${token}`);
      const hasBody =
        req.body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
      const res = await fetch(`${base}${req.path}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: req.body } : {}),
        redirect: 'manual',
      });
      const out: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        if (name !== 'set-cookie') out[name] = value;
      });
      return {
        status: res.status,
        headers: out,
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
    openEvents(deviceId, onMessage, onClose) {
      const token = credentialFor(deviceId);
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        onClose();
      };
      if (token === null) {
        queueMicrotask(finish);
        return { close: () => {} };
      }
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: `Bearer ${token}` },
      });
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') onMessage(event.data);
      };
      socket.onclose = finish;
      socket.onerror = finish;
      return {
        close: () => {
          socket.close();
          finish();
        },
      };
    },
  };
}

function textResponse(status: number, message: string): LocalResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: new TextEncoder().encode(JSON.stringify({ error: message })),
  };
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A phone names itself; keep that to one plain, short line. */
function cleanName(name: string): string {
  const flat = Array.from(name)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('')
    .trim()
    .slice(0, 64);
  return flat === '' ? 'Phone' : flat;
}
