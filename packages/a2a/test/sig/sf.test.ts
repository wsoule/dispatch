import { describe, expect, it } from 'bun:test';

import {
  parseDictionary,
  serializeInnerList,
  SfError,
  SfToken,
} from '../../src/sig/sf.js';
import type { InnerList, Item } from '../../src/sig/sf.js';
import { B24, REQRES } from './rfc9421-vectors.js';

describe('RFC 8941 dictionaries', () => {
  it('parses a Signature-Input member and serializes it back byte for byte', () => {
    for (const input of [B24.signatureInput, REQRES.signatureInput]) {
      const dict = parseDictionary(input);
      expect(dict.size).toBe(1);
      const [label, member] = [...dict][0];
      expect(`${label}=${serializeInnerList(member as InnerList)}`).toBe(input);
    }
    const reqres = parseDictionary(REQRES.signatureInput).get(
      'reqres'
    ) as InnerList;
    expect(reqres.items[3]).toEqual({
      value: '@authority',
      params: new Map([['req', true]]),
    });
    expect(reqres.params.get('created')).toBe(1618884479);
    expect(reqres.params.get('keyid')).toBe('test-key-ecc-p256');
  });

  it('reads byte sequences, booleans, tokens, decimals and several members', () => {
    const dict = parseDictionary(
      'sha-256=:d435Qo+nKZ+gLcUHn7GQtQ72hiBVAgqoLsZnZPiTGPk=:, a=?0, b, c=tok/en;p=1.5'
    );
    expect(
      Buffer.from((dict.get('sha-256') as Item).value as Uint8Array).length
    ).toBe(32);
    expect((dict.get('a') as Item).value).toBe(false);
    expect((dict.get('b') as Item).value).toBe(true);
    expect((dict.get('c') as Item).value).toEqual(new SfToken('tok/en'));
    expect(
      (dict.get('c') as { params: Map<string, unknown> }).params.get('p')
    ).toBe(1.5);
  });

  it('escapes and unescapes strings', () => {
    const list: InnerList = {
      items: [{ value: 'a"b\\c', params: new Map() }],
      params: new Map([['keyid', 'k"1']]),
    };
    const text = serializeInnerList(list);
    expect(text).toBe('("a\\"b\\\\c");keyid="k\\"1"');
    expect(parseDictionary(`x=${text}`).get('x')).toEqual(list);
  });

  it.each([
    'Sig=("@method")', // uppercase key
    'sig=("@method"', // unterminated inner list
    'sig=("@method");created=12a', // bad integer
    'sig="é"', // non-ASCII string
    'sig=:not base64!:', // bad byte sequence
    'sig=("@method"),', // trailing comma
    'sig=("a" "b") x', // junk after a member
    'sig=("x");created=1;created=2', // a duplicate parameter is fine in 8941 (last wins) but we refuse it
  ])('refuses %j', (text) => {
    expect(() => parseDictionary(text)).toThrow(SfError);
  });

  it('refuses a dictionary that names one key twice, unlike RFC 8941, which keeps the last', () => {
    expect(() => parseDictionary('a=1, a=2')).toThrow(SfError);
  });
});
