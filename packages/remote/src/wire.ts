import { sha256 } from '@noble/hashes/sha2.js';

import { concatBytes, toHex, utf8Decode, utf8Encode } from './bytes.js';

// Everything that crosses the relay, at two levels.
//
// The relay level is what the relay itself reads: a daemon's sign-in, the
// session ids it multiplexes phones under, and close codes. The payload level
// is what one phone and its daemon say to each other, which the relay only
// forwards: a tag byte, then either a public handshake message or ciphertext.
// Inside the ciphertext is a tunnel frame (frames.ts).

/** Close codes the relay sends a phone or a daemon. */
export const CLOSE = {
  /** The daemon this phone asked for is not connected to the relay. */
  daemonOffline: 4404,
  /** Another connection signed in as this daemon; this one is replaced. */
  replaced: 4409,
  /** Too many phone sessions open on one daemon. */
  tooMany: 4429,
  /** A daemon's sign-in was missing or malformed. */
  badAuth: 4401,
  /** The other end of this session went away. */
  peerGone: 4410,
} as const;

/** How long the session id that prefixes a relayed frame is. */
export const SID_BYTES = 8;

/** The largest frame either side or the relay will carry. A diff bigger than
 *  this fails with a clear error instead of stalling the socket. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Control messages between the relay and a daemon, as JSON text frames. */
export type DaemonControl =
  | { t: 'auth'; v: 1; secret: string }
  | { t: 'ready'; id: string }
  | { t: 'open'; sid: string }
  | { t: 'close'; sid: string };

/**
 * A daemon's id at the relay: the first 32 hex characters of a hash of its
 * relay secret. The relay recomputes it from the secret a daemon signs in
 * with, so knowing an id (it is in every pairing QR code) does not let anyone
 * sign in as that daemon. The secret is unrelated to the end-to-end keys: a
 * relay that keeps it can impersonate the daemon to the relay, never to a
 * phone.
 */
export function daemonIdFor(secret: Uint8Array): string {
  return toHex(
    sha256(concatBytes(utf8Encode('dispatch-remote/daemon-id\u0000'), secret))
  ).slice(0, 32);
}

/** Whether a string is shaped like a daemon id. */
export function isDaemonId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** Session ids are hex on the control channel and raw bytes on data frames. */
export function sidToBytes(sid: string): Uint8Array {
  const out = new Uint8Array(SID_BYTES);
  for (let i = 0; i < SID_BYTES; i++)
    out[i] = Number.parseInt(sid.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sidFromBytes(bytes: Uint8Array): string {
  return toHex(bytes.slice(0, SID_BYTES));
}

/** A data frame for the daemon's socket: session id, then the payload. */
export function prefixSid(sid: string, payload: Uint8Array): Uint8Array {
  return concatBytes(sidToBytes(sid), payload);
}

/** What a payload byte 0 says the rest is. */
export const TAG = {
  hello: 1,
  welcome: 2,
  reject: 3,
  sealed: 4,
} as const;

type Tag = (typeof TAG)[keyof typeof TAG];

/** A public handshake message as a payload. */
export function jsonPayload(tag: Tag, value: unknown): Uint8Array {
  return concatBytes(Uint8Array.of(tag), utf8Encode(JSON.stringify(value)));
}

/** Ciphertext as a payload. */
export function sealedPayload(ciphertext: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(TAG.sealed), ciphertext);
}

/** A payload's tag and body; JSON bodies parsed, null when they will not. */
export function readPayload(payload: Uint8Array): {
  tag: number;
  body: Uint8Array;
  json: unknown;
} {
  const tag = payload[0] ?? 0;
  const body = payload.subarray(1);
  let json: unknown = null;
  if (tag !== TAG.sealed) {
    try {
      json = JSON.parse(utf8Decode(body));
    } catch {
      json = null;
    }
  }
  return { tag, body, json };
}

/** Bytes from whatever a WebSocket handed a message listener, or null for a
 *  text frame. Bun gives Buffer, browsers and React Native ArrayBuffer. */
export function binaryOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
