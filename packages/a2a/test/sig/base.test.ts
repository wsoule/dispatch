import { describe, expect, it } from 'bun:test';
import { createPublicKey } from 'node:crypto';

import { SigBaseError, signatureBase } from '../../src/sig/base.js';
import { contentDigest, digestMatches } from '../../src/sig/digest.js';
import { parseDictionary } from '../../src/sig/sf.js';
import type { InnerList, Item } from '../../src/sig/sf.js';
import { verifyBase } from '../../src/sig/verify.js';
import {
  B24,
  REQRES,
  TEST_KEY_ECC_P256,
  TEST_REQUEST,
  TEST_RESPONSE,
} from './rfc9421-vectors.js';

const covered = (input: string): InnerList =>
  [...parseDictionary(input).values()][0] as InnerList;
const sigBytes = (header: string): Uint8Array =>
  ([...parseDictionary(header).values()][0] as Item).value as Uint8Array;
const { d: _d, ...publicJwk } = TEST_KEY_ECC_P256;
const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });

describe('the signature base (RFC 9421 §2.5)', () => {
  it('matches Appendix B.2.4 byte for byte, and its published signature verifies', () => {
    const base = signatureBase(covered(B24.signatureInput), {
      response: TEST_RESPONSE,
    });
    expect(base).toBe(B24.base);
    expect(verifyBase(base, sigBytes(B24.signature), publicKey)).toBe(true);
  });

  it('matches §2.4 for request components under req, and its signature verifies', () => {
    const base = signatureBase(covered(REQRES.signatureInput), {
      response: REQRES.response,
      request: TEST_REQUEST,
    });
    expect(base).toBe(REQRES.base);
    expect(verifyBase(base, sigBytes(REQRES.signature), publicKey)).toBe(true);
  });

  it('fails verification when one byte of the base changes', () => {
    const base = signatureBase(covered(B24.signatureInput), {
      response: TEST_RESPONSE,
    });
    expect(
      verifyBase(base.replace('200', '201'), sigBytes(B24.signature), publicKey)
    ).toBe(false);
  });

  it('derives request components from the target URI', () => {
    const list = covered(
      'x=("@method" "@target-uri" "@authority" "@path" "@query" "content-type")'
    );
    const base = signatureBase(list, {
      request: {
        method: 'POST',
        targetUri: 'https://Agent.Example:443/a2a/v1/message:send',
        headers: new Headers({ 'content-type': 'application/json' }),
      },
    });
    expect(base.split('\n').slice(0, 6)).toEqual([
      '"@method": POST',
      '"@target-uri": https://agent.example/a2a/v1/message:send',
      '"@authority": agent.example',
      '"@path": /a2a/v1/message:send',
      '"@query": ?',
      '"content-type": application/json',
    ]);
    expect(
      signatureBase(covered('x=("@authority")'), {
        request: {
          method: 'GET',
          targetUri: 'http://127.0.0.1:7450/x',
          headers: new Headers(),
        },
      }).split('\n')[0]
    ).toBe('"@authority": 127.0.0.1:7450');
  });

  it.each([
    ['a field the message lacks', 'x=("a2a-version")', 'request'],
    ['@status on a request', 'x=("@status")', 'request'],
    ['req on a request', 'x=("@method";req)', 'request'],
    ['req without the request at hand', 'x=("@method";req)', 'response'],
    ['an unknown derived component', 'x=("@scheme-ish")', 'request'],
    ['a parameter it does not understand', 'x=("content-type";sf)', 'request'],
    [
      'the same component twice',
      'x=("content-type" "content-type")',
      'request',
    ],
    [
      '@signature-params listed as a component',
      'x=("@signature-params")',
      'request',
    ],
  ])('refuses %s', (_why, input, side) => {
    const message =
      side === 'request'
        ? {
            request: {
              ...TEST_REQUEST,
              headers: new Headers(TEST_REQUEST.headers),
            },
          }
        : { response: TEST_RESPONSE };
    expect(() => signatureBase(covered(input), message)).toThrow(SigBaseError);
  });
});

describe('Content-Digest (RFC 9530)', () => {
  it('matches the RFC 9530 Appendix B.1 sha-256 value', () => {
    const body = new TextEncoder().encode('{"hello": "world"}\n');
    expect(contentDigest(body)).toBe(
      'sha-256=:RK/0qy18MlBSVnWgjwz6lZEWjP/lF5HF9bvEF8FabDg=:'
    );
  });

  it('requires a matching sha-256 member and ignores members it does not know', () => {
    const body = new TextEncoder().encode('{"hello": "world"}\n');
    const ok = 'sha-256=:RK/0qy18MlBSVnWgjwz6lZEWjP/lF5HF9bvEF8FabDg=:';
    expect(digestMatches(ok, body)).toBe(true);
    expect(digestMatches(`unixsum=:AAAA:, ${ok}`, body)).toBe(true);
    expect(digestMatches(ok, new TextEncoder().encode('{}'))).toBe(false);
    expect(digestMatches('sha-512=:AAAA:', body)).toBe(false);
    expect(digestMatches('garbage', body)).toBe(false);
    expect(digestMatches(null, body)).toBe(false);
  });
});
