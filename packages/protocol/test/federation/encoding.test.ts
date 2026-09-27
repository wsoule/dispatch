import { describe, expect, it } from 'bun:test';

import { b64u, crockford32, fromB64u } from '../../src/federation/encoding.js';

describe('fromB64u', () => {
  it('decodes the canonical base64url of some bytes and nothing else', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0x10, 0x41]);
    const text = b64u(bytes);
    expect(text).toBe('-_8QQQ');
    expect(fromB64u(text)).toEqual(bytes);
    // Each of these decodes to bytes that re-encode to something else.
    for (const other of [
      `${text.slice(0, -1)}R`, // stray low bits in the last character
      text.slice(0, 5), // a length of 1 mod 4
      `${text}==`, // padding
      '+/8QQQ', // the standard alphabet
    ])
      expect(() => fromB64u(other)).toThrow();
  });
});

describe('crockford32', () => {
  // Each prefix ends at another bit offset; checked against Python's base32.
  it('writes five bits at a time, most significant first', () => {
    const bytes = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]);
    const printed = ['28', '28T0', '28T5C', '28T5CY0', '28T5CY4T'];
    printed.forEach((text, i) =>
      expect(crockford32(bytes.subarray(0, i + 1))).toBe(text)
    );
    expect(crockford32(Buffer.alloc(0))).toBe('');
    expect(crockford32(Buffer.from([0xff]))).toBe('ZW');
    expect(crockford32(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(
      '000G40R40M30E209'
    );
  });
});
