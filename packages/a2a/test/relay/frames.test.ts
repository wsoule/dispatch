import { MessagingError } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  answerChallenge,
  challengeString,
  checkAuth,
} from '../../src/relay/challenge.js';
import {
  callHeaders,
  MAX_FRAME_BODY,
  parseFrame,
} from '../../src/relay/frames.js';
import { ecThumbprint, publicJwkOf } from '../../src/sig/keys.js';

const call = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    t: 'call',
    id: 'c'.repeat(22),
    route: '/tasks/x',
    method: 'GET',
    headers: { 'content-type': 'application/json' },
    body: null,
    ...over,
  });

describe('frames', () => {
  it('parses each side’s frames field by field', () => {
    expect(parseFrame(call(), 'daemon')).toMatchObject({
      t: 'call',
      route: '/tasks/x',
    });
    expect(parseFrame('{"t":"ping"}', 'daemon')).toEqual({ t: 'ping' });
    expect(
      parseFrame(
        JSON.stringify({
          t: 'result',
          id: 'c'.repeat(22),
          status: 200,
          headers: {},
          body: '{}',
        }),
        'relay'
      )
    ).toMatchObject({ t: 'result', status: 200 });
    expect(parseFrame('{"t":"pong"}', 'relay')).toEqual({ t: 'pong' });
  });

  it('refuses an unknown t, a frame meant for the other side, and junk', () => {
    for (const [raw, side] of [
      ['{"t":"nope"}', 'daemon'],
      ['{"t":"pong"}', 'daemon'],
      [call(), 'relay'],
      ['not json', 'relay'],
      ['[]', 'daemon'],
      [
        JSON.stringify({
          t: 'result',
          id: 'x',
          status: 'ok',
          headers: {},
          body: null,
        }),
        'relay',
      ],
    ] as const)
      expect(() => parseFrame(raw, side)).toThrow(MessagingError);
  });

  it('refuses an oversize body and non-string or unlisted headers', () => {
    expect(() =>
      parseFrame(call({ body: 'x'.repeat(MAX_FRAME_BODY + 1) }), 'daemon')
    ).toThrow(MessagingError);
    expect(() =>
      parseFrame(call({ headers: { 'content-type': 7 } }), 'daemon')
    ).toThrow(MessagingError);
    expect(() =>
      parseFrame(call({ headers: { cookie: 'a=b' } }), 'daemon')
    ).toThrow(MessagingError);
  });

  it('passes only the allowlisted headers into a call', () => {
    const h = new Headers({
      'content-type': 'application/json',
      'x-a2a-client-authorization': 'Bearer t',
      authorization: 'Bearer host-token',
      cookie: 'a=b',
    });
    expect(callHeaders(h)).toEqual({
      'content-type': 'application/json',
      'x-a2a-client-authorization': 'Bearer t',
    });
  });
});

describe('the tenant challenge', () => {
  const key = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicJwkOf(
      publicKey.export({ format: 'jwk' }) as Record<string, string>
    );
    return { privateKey, jwk, tp: ecThumbprint(jwk)! };
  };
  const RELAY = 'wss://relay.example.com/v1/tenants';

  it('is tag-separated and binds the relay URL, thumbprint and nonce', () => {
    expect(challengeString(RELAY, 'tp', 'n')).toBe(
      `dispatch-a2a-relay-v1\n${RELAY}\ntp\nn`
    );
  });

  it('admits an allowlisted key that signed this nonce for this relay', () => {
    const k = key();
    const auth = answerChallenge({
      relayUrl: RELAY,
      nonce: 'n1',
      privateKey: k.privateKey,
      jwk: k.jwk,
    });
    expect(checkAuth(auth, RELAY, 'n1', (tp) => tp === k.tp)).toEqual({
      ok: true,
      thumbprint: k.tp,
    });
    expect(checkAuth(auth, RELAY, 'n1', () => false)).toMatchObject({
      ok: false,
    });
    expect(
      checkAuth(auth, 'wss://other.example.com/v1/tenants', 'n1', () => true)
    ).toMatchObject({ ok: false });
    expect(checkAuth(auth, RELAY, 'n2', () => true)).toMatchObject({
      ok: false,
    });
    // A thumbprint that is not the key's.
    expect(
      checkAuth({ ...auth, thumbprint: key().tp }, RELAY, 'n1', () => true)
    ).toMatchObject({ ok: false });
  });
});

describe('batch 5 review R4, R5', () => {
  it('R4: counts UTF-8 bytes, not UTF-16 chars, against the body cap', () => {
    // 'é' is one UTF-16 unit and two UTF-8 bytes.
    const half = 'é'.repeat(MAX_FRAME_BODY / 2);
    expect(() => parseFrame(call({ body: half }), 'daemon')).not.toThrow();
    expect(() => parseFrame(call({ body: `${half}é` }), 'daemon')).toThrow(
      MessagingError
    );
  });

  it('R5: a challenge nonce is base64url, 22 to 64 characters', () => {
    const challenge = (nonce: string) =>
      JSON.stringify({ t: 'challenge', nonce });
    expect(parseFrame(challenge('a'.repeat(22)), 'daemon')).toMatchObject({
      t: 'challenge',
    });
    for (const bad of [
      'a'.repeat(21),
      'a'.repeat(65),
      'a'.repeat(21) + '+',
      '',
    ])
      expect(() => parseFrame(challenge(bad), 'daemon')).toThrow(
        MessagingError
      );
  });
});
