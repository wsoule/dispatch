import { describe, expect, test } from 'bun:test';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  verify,
} from 'node:crypto';

import {
  encryptPayload,
  generateVapidKeys,
  isPushSubscription,
  sendPush,
  vapidAuthorization,
} from '../../src/mobile/webPush.js';

// RFC 8291 §5, "Push Message Encryption Example".
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

// The browser's side of RFC 8291, written out independently of the sender so
// a round trip is a real check: decrypt with the subscription's private key.
function decryptAsBrowser(
  body: Buffer,
  uaPrivate: Buffer,
  authSecret: Buffer
): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const ikm = hmac(
    hmac(authSecret, ecdh.computeSecret(asPublic)),
    Buffer.concat([
      Buffer.from('WebPush: info\0'),
      uaPublic,
      asPublic,
      Buffer.from([1]),
    ])
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01'));
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01'));
  const decipher = createDecipheriv(
    'aes-128-gcm',
    cek.subarray(0, 16),
    nonce.subarray(0, 12)
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  expect(padded[padded.length - 1]).toBe(2);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

describe('encryptPayload', () => {
  test("matches RFC 8291's worked example byte for byte", () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      {
        senderPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'),
        salt: Buffer.from(RFC.salt, 'base64url'),
      }
    );
    expect(body.toString('base64url')).toBe(RFC.message);
  });

  test('a browser holding the subscription key can decrypt it', () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const body = encryptPayload(Buffer.from('{"kind":"decision"}'), {
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    });
    expect(decryptAsBrowser(body, browser.getPrivateKey(), auth)).toBe(
      '{"kind":"decision"}'
    );
  });
});

describe('vapidAuthorization', () => {
  test('is an ES256 JWT for the endpoint origin that verifies against k', () => {
    const keys = generateVapidKeys();
    const now = new Date('2026-10-20T12:00:00Z');
    const header = vapidAuthorization(
      'https://web.push.apple.com/QGuQ/abc',
      keys,
      'https://dispatch.foo',
      now
    );
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [jwt, k] = [match![1], match![2]];
    expect(k).toBe(keys.publicKey);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now.getTime() / 1000 + 12 * 3600,
      sub: 'https://dispatch.foo',
    });
    const point = Buffer.from(k, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url')
      )
    ).toBe(true);
  });
});

describe('isPushSubscription', () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
  test('accepts an https endpoint with both keys', () => {
    expect(
      isPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys })
    ).toBe(true);
  });
  test('refuses a plain-http endpoint, which would leak the VAPID JWT', () => {
    expect(isPushSubscription({ endpoint: 'http://evil.test/x', keys })).toBe(
      false
    );
  });
  test("accepts each browser's push service", () => {
    for (const endpoint of [
      'https://web.push.apple.com/QGuQ',
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])
      expect(isPushSubscription({ endpoint, keys })).toBe(true);
  });

  test('refuses any other host, so a device cannot aim the daemon elsewhere', () => {
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/api/tasks',
      'https://router.local/admin',
      'https://fcm.googleapis.com.evil.test/x',
      'https://evilpush.apple.com.attacker.net/x',
      'https://fcm.googleapis.com:8443/x',
    ])
      expect(isPushSubscription({ endpoint, keys })).toBe(false);
  });

  test('refuses keys of the wrong length', () => {
    expect(
      isPushSubscription({
        endpoint: 'https://fcm.googleapis.com/x',
        keys: { p256dh: 'AAAA', auth: RFC.authSecret },
      })
    ).toBe(false);
  });
});

describe('sendPush', () => {
  const subscription = {
    endpoint: 'https://push.example/sub/1',
    keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
  };
  const vapid = generateVapidKeys();

  test('posts an aes128gcm body with VAPID, TTL and topic headers', async () => {
    let seen: Request | null = null;
    const outcome = await sendPush(
      subscription,
      { payload: { kind: 'decision' }, topic: 'decisions' },
      vapid,
      {
        subject: 'https://dispatch.foo',
        fetch: ((input: string, init: RequestInit) => {
          seen = new Request(input, init);
          return Promise.resolve(new Response(null, { status: 201 }));
        }) as unknown as typeof fetch,
      }
    );
    expect(outcome).toEqual({ kind: 'sent' });
    const req = seen as unknown as Request;
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('topic')).toBe('decisions');
    expect(req.headers.get('ttl')).toBe('86400');
    expect(req.headers.get('authorization')).toStartWith('vapid t=');
    const body = Buffer.from(await req.arrayBuffer());
    expect(
      decryptAsBrowser(
        body,
        Buffer.from(RFC.uaPrivate, 'base64url'),
        Buffer.from(RFC.authSecret, 'base64url')
      )
    ).toBe('{"kind":"decision"}');
  });

  test('reports a 410 as gone so the subscription is forgotten', async () => {
    const outcome = await sendPush(subscription, { payload: {} }, vapid, {
      subject: 'https://dispatch.foo',
      fetch: (() =>
        Promise.resolve(
          new Response('', { status: 410 })
        )) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'gone' });
  });

  test('never throws when the push service is unreachable', async () => {
    const outcome = await sendPush(subscription, { payload: {} }, vapid, {
      subject: 'https://dispatch.foo',
      fetch: (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      status: null,
      error: 'ECONNREFUSED',
    });
  });
});
