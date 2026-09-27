import { describe, expect, it } from 'bun:test';

import {
  canonicalize,
  CanonicalizeError,
  canonicalizeLenient,
  MAX_JSON_DEPTH,
} from '../../src/federation/jcs.js';

describe('canonicalize (RFC 8785)', () => {
  // Escapes keep the RFC's code points; a precomposed U+FB33 would not survive NFC.
  it('sorts object keys by UTF-16 code units (§3.2.3)', () => {
    const input: Record<string, string> = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\u{1f600}': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    const order = [
      '\r',
      '1',
      '\u0080',
      '\u00f6',
      '\u20ac',
      '\u{1f600}',
      '\ufb33',
    ];
    expect(canonicalize(input)).toBe(
      `{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`).join(',')}}`
    );
  });

  it('writes numbers as ECMAScript does (Appendix B samples)', () => {
    expect(
      canonicalize([
        1e21, 1e-7, 0.000001, -0, 4.5, 0.002, 333333333.3333333, 1e30,
      ])
    ).toBe('[1e+21,1e-7,0.000001,0,4.5,0.002,333333333.3333333,1e+30]');
  });

  it('refuses non-finite numbers and drops undefined members', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizeError);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalizeError
    );
    expect(() => canonicalize({ a: 1n })).toThrow(CanonicalizeError);
    expect(canonicalize({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalize({ b: [1, { d: 1, c: 2 }], a: 'x' })).toBe(
      '{"a":"x","b":[1,{"c":2,"d":1}]}'
    );
  });

  // RFC 8785 takes I-JSON, which forbids them; JSON.stringify would escape one.
  it('refuses lone surrogates in strings and keys, but not a pair', () => {
    expect(() => canonicalize('a\ud800')).toThrow('lone surrogate');
    expect(() => canonicalize(['\udc00b'])).toThrow('lone surrogate');
    expect(() => canonicalize({ '\ud83d': 1 })).toThrow('lone surrogate');
    expect(() => canonicalize({ a: ['\ud800'] })).toThrow(CanonicalizeError);
    expect(canonicalize({ '\u{1f600}': '\u{1f600}' })).toBe(
      '{"\u{1f600}":"\u{1f600}"}'
    );
  });

  it('escapes a lone surrogate in text that is never hashed', () => {
    expect(canonicalizeLenient({ b: 'a\ud800', '\udc00': 1 })).toBe(
      '{"b":"a\\ud800","\\udc00":1}'
    );
    expect(() => canonicalizeLenient(Number.NaN)).toThrow();
  });

  // Stack depth differs between runtimes, so a fixed bound keeps every peer's
  // verdict on the same op identical.
  it('refuses nesting past MAX_JSON_DEPTH, and cycles, with a CanonicalizeError', () => {
    const nested = (depth: number, wrap: (v: unknown) => unknown) => {
      let v: unknown = 1;
      for (let i = 0; i < depth; i++) v = wrap(v);
      return v;
    };
    const inArray = (v: unknown) => [v];
    const inObject = (v: unknown) => ({ a: v });
    for (const wrap of [inArray, inObject]) {
      expect(canonicalize(nested(MAX_JSON_DEPTH, wrap))).toContain('1');
      const deep = nested(MAX_JSON_DEPTH + 1, wrap);
      expect(() => canonicalize(deep)).toThrow(CanonicalizeError);
      expect(() => canonicalizeLenient(deep)).toThrow(CanonicalizeError);
    }
    // Deep enough to overflow the stack of any runtime without the bound.
    expect(() => canonicalize(nested(100_000, inArray))).toThrow(
      CanonicalizeError
    );
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const ring: unknown[] = [];
    ring.push(ring);
    for (const cyclic of [loop, ring])
      expect(() => canonicalize(cyclic)).toThrow(CanonicalizeError);
  });
});
