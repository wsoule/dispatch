import { concatBytes, utf8Decode, utf8Encode } from './bytes.js';

// What a phone and its daemon say inside the encryption: the daemon's own
// HTTP API and its `/ws` event stream, carried as frames. Each frame is a
// 4-byte big-endian header length, a JSON header, and the raw body bytes, so
// a response body (a diff, a log) is never base64'd on top of the cipher.

/** Phone to daemon. */
export type PhoneFrame =
  | {
      t: 'req';
      id: number;
      method: string;
      path: string;
      headers: Record<string, string>;
    }
  | { t: 'ws-open'; id: number; path: string }
  | { t: 'ws-close'; id: number }
  | { t: 'ping' };

/** Daemon to phone. */
export type DaemonFrame =
  | { t: 'ready'; name: string; device: string }
  | { t: 'res'; id: number; status: number; headers: Record<string, string> }
  | { t: 'ws-msg'; id: number }
  | { t: 'ws-close'; id: number }
  | { t: 'error'; id: number | null; message: string }
  | { t: 'pong' };

export type AnyFrame = PhoneFrame | DaemonFrame;

/** One frame and its body as bytes. */
export function encodeFrame(
  header: AnyFrame,
  body: Uint8Array = new Uint8Array(0)
): Uint8Array {
  const head = utf8Encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, head.length);
  return concatBytes(length, head, body);
}

/** A frame back from its bytes; throws on anything that is not one. */
export function decodeFrame<T extends AnyFrame>(
  bytes: Uint8Array
): { header: T; body: Uint8Array } {
  if (bytes.length < 4) throw new Error('short frame');
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0);
  if (4 + length > bytes.length) throw new Error('truncated frame header');
  const header = JSON.parse(utf8Decode(bytes.subarray(4, 4 + length))) as T;
  if (typeof header !== 'object' || header === null || !('t' in header))
    throw new Error('malformed frame header');
  return { header, body: bytes.subarray(4 + length) };
}
