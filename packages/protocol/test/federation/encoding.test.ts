import { describe, expect, it } from 'bun:test';

import { b64u, fromB64u } from '../../src/federation/encoding.js';

describe('fromB64u', () => {
  it('decodes the canonical base64url of some bytes and nothing else', () => {
    const bytes = Buffer.from('ABCD');
    expect(b64u(bytes)).toBe('QUJDRA');
    expect(fromB64u('QUJDRA')).toEqual(bytes);
    // Stray low bits in the last character, a length of 1 mod 4, padding
    // and the standard alphabet each decode to bytes that re-encode otherwise.
    for (const other of ['QUJDRB', 'QUJDQ', 'QUJDRA==', 'QUJD+A'])
      expect(() => fromB64u(other)).toThrow();
  });
});
