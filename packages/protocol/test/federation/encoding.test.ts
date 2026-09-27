import { describe, expect, it } from 'bun:test';

import { b64u, fromB64u } from '../../src/federation/encoding.js';

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
