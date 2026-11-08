// Byte helpers with no platform dependency. The iOS app runs this package on
// Hermes, which ships neither Buffer nor a dependable TextDecoder, so UTF-8
// and base64url are done by hand here rather than borrowed from the runtime.

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as TextEncoder does. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
  }
  return Uint8Array.from(out);
}

/** A string from UTF-8 bytes. Malformed sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let code = 0xfffd;
    let width = 1;
    if (b0 < 0x80) {
      code = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0 && isCont(bytes[i + 1])) {
      code = ((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f);
      width = 2;
    } else if (
      b0 >= 0xe0 &&
      b0 < 0xf0 &&
      isCont(bytes[i + 1]) &&
      isCont(bytes[i + 2])
    ) {
      code =
        ((b0 & 0x0f) << 12) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 2] ?? 0) & 0x3f);
      width = 3;
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    } else if (
      b0 >= 0xf0 &&
      b0 < 0xf5 &&
      isCont(bytes[i + 1]) &&
      isCont(bytes[i + 2]) &&
      isCont(bytes[i + 3])
    ) {
      code =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f);
      width = 4;
      if (code < 0x10000 || code > 0x10ffff) code = 0xfffd;
    }
    out += String.fromCodePoint(code);
    i += width;
  }
  return out;
}

function isCont(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url, the form a URL or QR code carries without escaping. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

/** Bytes from unpadded base64url; throws on any character outside it. */
export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('invalid base64url length');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B64.indexOf(ch);
    if (value === -1) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Lowercase hex, for ids derived from hashes. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** One array from several, in order. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Constant-time equality for two byte strings of any length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
