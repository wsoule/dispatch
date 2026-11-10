import { describe, expect, test } from 'bun:test';

import {
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../src/bytes.js';
import { decodeFrame, encodeFrame } from '../src/frames.js';
import {
  answerHello,
  generateKeyPair,
  parseHello,
  PhoneHandshake,
  SessionCipher,
} from '../src/handshake.js';
import { pairingUrl, parsePairingUrl } from '../src/pairing.js';
import { daemonIdFor, isDaemonId } from '../src/wire.js';

function sessionPair(
  opts: { phonePsk?: Uint8Array; daemonPsk?: Uint8Array } = {}
) {
  const daemon = generateKeyPair();
  const phone = generateKeyPair();
  const pairing =
    opts.phonePsk === undefined
      ? null
      : {
          offerId: '0123456789abcdef',
          code: opts.phonePsk,
          name: 'Test phone',
        };
  const handshake = new PhoneHandshake(phone, daemon.publicKey, pairing);
  const parsed = parseHello(JSON.parse(JSON.stringify(handshake.hello)));
  if (parsed === null) throw new Error('hello did not parse');
  const answer = answerHello(daemon, parsed, opts.daemonPsk ?? null);
  const phoneKeys = handshake.finish(answer.welcome);
  return {
    phone: new SessionCipher(phoneKeys),
    daemon: new SessionCipher(answer.keys),
    parsed,
  };
}

describe('bytes', () => {
  test('utf8 round-trips text beyond the BMP', () => {
    const text = 'merge ✓ 🚀 naïve';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(utf8Encode(text)).toEqual(new TextEncoder().encode(text));
  });

  test('base64url round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });
});

describe('handshake', () => {
  test('both sides derive the same keys and frames open in order', () => {
    const { phone, daemon } = sessionPair();
    const first = phone.seal(utf8Encode('one'));
    const second = phone.seal(utf8Encode('two'));
    expect(utf8Decode(daemon.open(first))).toBe('one');
    expect(utf8Decode(daemon.open(second))).toBe('two');
    expect(utf8Decode(phone.open(daemon.seal(utf8Encode('back'))))).toBe(
      'back'
    );
  });

  test('a replayed or reordered frame does not open', () => {
    const { phone, daemon } = sessionPair();
    const first = phone.seal(utf8Encode('one'));
    const second = phone.seal(utf8Encode('two'));
    expect(() => daemon.open(second)).toThrow();
    const fresh = sessionPair();
    const a = fresh.phone.seal(utf8Encode('a'));
    fresh.daemon.open(a);
    expect(() => fresh.daemon.open(a)).toThrow();
    void first;
  });

  test('a tampered frame does not open', () => {
    const { phone, daemon } = sessionPair();
    const sealed = phone.seal(utf8Encode('approve'));
    sealed[0] = (sealed[0] ?? 0) ^ 1;
    expect(() => daemon.open(sealed)).toThrow();
  });

  test('pairing only works with the code from the QR code', () => {
    const code = crypto.getRandomValues(new Uint8Array(32));
    const right = sessionPair({ phonePsk: code, daemonPsk: code });
    expect(right.parsed.pair).toBe('0123456789abcdef');
    expect(right.parsed.name).toBe('Test phone');
    expect(
      utf8Decode(right.daemon.open(right.phone.seal(utf8Encode('hi'))))
    ).toBe('hi');

    const guessed = crypto.getRandomValues(new Uint8Array(32));
    const wrong = sessionPair({ phonePsk: guessed, daemonPsk: code });
    expect(() =>
      wrong.daemon.open(wrong.phone.seal(utf8Encode('hi')))
    ).toThrow();
  });

  test('a phone talking to the wrong daemon key cannot open its frames', () => {
    const daemon = generateKeyPair();
    const impostor = generateKeyPair();
    const phone = generateKeyPair();
    const handshake = new PhoneHandshake(phone, daemon.publicKey, null);
    const parsed = parseHello(handshake.hello);
    if (parsed === null) throw new Error('hello did not parse');
    // A relay answering with its own key instead of the daemon's.
    const answer = answerHello({ ...impostor }, { ...parsed }, null);
    const phoneSide = new SessionCipher(handshake.finish(answer.welcome));
    const relaySide = new SessionCipher(answer.keys);
    expect(() => phoneSide.open(relaySide.seal(utf8Encode('ready')))).toThrow();
  });

  test('parseHello refuses anything malformed', () => {
    expect(parseHello(null)).toBeNull();
    expect(parseHello({ t: 'hello', v: 2 })).toBeNull();
    expect(parseHello({ t: 'hello', v: 1, e: 'x', s: 'y', d: 'z' })).toBeNull();
  });
});

describe('frames', () => {
  test('a header and binary body round-trip', () => {
    const body = Uint8Array.of(0, 255, 7);
    const bytes = encodeFrame(
      { t: 'res', id: 3, status: 200, headers: { a: 'b' } },
      body
    );
    const decoded = decodeFrame(bytes);
    expect(decoded.header).toEqual({
      t: 'res',
      id: 3,
      status: 200,
      headers: { a: 'b' },
    });
    expect(Uint8Array.from(decoded.body)).toEqual(body);
  });

  test('a truncated frame throws', () => {
    expect(() => decodeFrame(Uint8Array.of(0, 0, 0, 9, 1))).toThrow();
  });
});

describe('pairing URL', () => {
  const offer = {
    relay: 'wss://remote.dispatch.foo',
    daemonId: daemonIdFor(new Uint8Array(32)),
    daemonKey: generateKeyPair().publicKey,
    offerId: '0123456789abcdef',
    code: crypto.getRandomValues(new Uint8Array(32)),
    name: "Striker's Mac · dispatch",
  };

  test('round-trips', () => {
    const parsed = parsePairingUrl(pairingUrl(offer));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.offer).toEqual(offer);
  });

  test('refuses a plain-ws relay off this machine', () => {
    const parsed = parsePairingUrl(
      pairingUrl({ ...offer, relay: 'ws://evil.example' })
    );
    expect(parsed).toEqual({
      ok: false,
      error: 'the code names a relay that is not wss://',
    });
    expect(
      parsePairingUrl(pairingUrl({ ...offer, relay: 'ws://127.0.0.1:4000' })).ok
    ).toBe(true);
  });

  test('refuses other links', () => {
    expect(parsePairingUrl('https://dispatch.foo').ok).toBe(false);
  });

  test('daemon ids are 32 hex characters', () => {
    expect(isDaemonId(offer.daemonId)).toBe(true);
    expect(isDaemonId('nope')).toBe(false);
  });
});
