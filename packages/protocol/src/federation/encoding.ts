import { createHash } from 'node:crypto';

const B64U = /^[A-Za-z0-9_-]*$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// Decodes only the one spelling b64u writes: padding, the standard alphabet
// and stray trailing bits are refused, so no value has a second encoding.
export function fromB64u(text: string): Buffer {
  if (!B64U.test(text)) throw new TypeError('not base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (b64u(bytes) !== text) throw new TypeError('not canonical base64url');
  return bytes;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// Crockford base32, most significant bit first, no padding.
export function crockford32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD.charAt((buffer << (5 - bits)) & 31);
  return out;
}
