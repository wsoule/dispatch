import type { JsonWebKey } from 'node:crypto';
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

// Web Push from the daemon straight to a phone's push service, with no
// third-party relay and no dependency: RFC 8030 delivery, VAPID sender
// identification (RFC 8292) and aes128gcm payload encryption (RFC 8291).
//
// The push service (Apple's, Google's, Mozilla's) only ever sees ciphertext:
// the phone's browser generated the key the payload is encrypted to and never
// gave it out. It still sees sizes and timing, which is why the notifier keeps
// payloads to a kind, an id and a title.

/** What a browser's PushSubscription.toJSON() hands back. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The daemon's VAPID identity: an ECDSA P-256 keypair, kept as a JWK private
 *  key plus the uncompressed public point browsers want as
 *  `applicationServerKey`. */
export interface VapidKeys {
  /** base64url of the 65-byte uncompressed public point. */
  publicKey: string;
  /** The private key as a JWK (`kty: EC`, `crv: P-256`, with `d`). */
  privateJwk: JsonWebKey;
}

/** A fresh VAPID keypair. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicPointOf(jwk), privateJwk: jwk };
}

function publicPointOf(jwk: JsonWebKey): string {
  if (jwk.x === undefined || jwk.y === undefined)
    throw new Error('VAPID key has no public point');
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
}

/** Whether a value read from disk is a usable VAPID keypair. */
export function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<VapidKeys>;
  return (
    typeof v.publicKey === 'string' &&
    typeof v.privateJwk === 'object' &&
    v.privateJwk !== null &&
    typeof v.privateJwk.d === 'string'
  );
}

// The push services browsers subscribe through: Apple (Safari, iOS), Google
// (Chrome, Android, Chromium browsers), Mozilla (Firefox) and Microsoft
// (Edge). A subscription's endpoint is where the daemon will POST, so it is
// held to these hosts: anything else would let whoever holds a device token
// point the daemon at an address of their choosing (a metadata service, a
// router's admin page) and have it send requests there.
const PUSH_SERVICE_HOSTS: readonly string[] = [
  'push.apple.com',
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

/** Whether an endpoint is on one of the known push services, on the default
 *  https port. */
function isPushServiceEndpoint(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some(
    (known) => host === known || host.endsWith(`.${known}`)
  );
}

/** Whether a value posted by a page is a push subscription we could send to:
 *  an endpoint on a known push service and both keys. */
export function isPushSubscription(
  value: unknown
): value is PushSubscriptionJson {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PushSubscriptionJson>;
  if (typeof v.endpoint !== 'string' || v.endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(v.endpoint);
  } catch {
    return false;
  }
  return (
    isPushServiceEndpoint(url) &&
    typeof v.keys === 'object' &&
    v.keys !== null &&
    typeof v.keys.p256dh === 'string' &&
    Buffer.from(v.keys.p256dh, 'base64url').length === 65 &&
    typeof v.keys.auth === 'string' &&
    Buffer.from(v.keys.auth, 'base64url').length === 16
  );
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Test seams for RFC 8291's worked example: the sender's ephemeral key and the
 *  salt are random in real use. */
export interface EncryptOverrides {
  /** The application server's ephemeral private key, raw 32 bytes. */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
}

/**
 * Encrypts `plaintext` to a browser's push subscription keys as one aes128gcm
 * record (RFC 8188 framing, RFC 8291 key derivation). The result is the whole
 * request body: a header carrying the salt, the record size and the sender's
 * ephemeral public key, then the ciphertext.
 */
export function encryptPayload(
  plaintext: Buffer,
  keys: PushSubscriptionJson['keys'],
  overrides: EncryptOverrides = {}
): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (overrides.senderPrivateKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(overrides.senderPrivateKey);
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = overrides.salt ?? randomBytes(16);

  // RFC 8291 §3.4: mix the subscription's auth secret into the ECDH secret.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // RFC 8188 §2.2: the content key and nonce, from the salt.
  const prk = hmac(salt, ikm);
  const cek = hmac(
    prk,
    Buffer.from('Content-Encoding: aes128gcm\0\x01', 'utf8')
  ).subarray(0, 16);
  const nonce = hmac(
    prk,
    Buffer.from('Content-Encoding: nonce\0\x01', 'utf8')
  ).subarray(0, 12);

  // One record, so it is the last one: the 0x02 delimiter, no padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * The VAPID `Authorization` header for one push service: an ES256 JWT naming
 * the service's origin as audience, signed by the daemon's key, plus the
 * public key it verifies against. `subject` is the contact the push service
 * may use about abuse; Apple refuses a JWT without a real-looking one.
 */
export function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  now: Date = new Date()
): string {
  const audience = new URL(endpoint).origin;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: audience,
    // Under the 24h ceiling RFC 8292 sets.
    exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${unsigned}.${signature}, k=${vapid.publicKey}`;
}

export interface PushMessage {
  /** The JSON the service worker's push handler receives. */
  payload: unknown;
  /** Replaces an undelivered message with the same topic on the push
   *  service (RFC 8030 §5.4): at most 32 base64url characters. */
  topic?: string;
  /** Seconds the push service keeps it for an offline phone. */
  ttlSeconds?: number;
}

export type PushOutcome =
  | { kind: 'sent' }
  /** The subscription is gone for good (404/410): forget it. */
  | { kind: 'gone' }
  | { kind: 'failed'; status: number | null; error: string };

/** Sends one message to one subscription. Never throws. */
export async function sendPush(
  subscription: PushSubscriptionJson,
  message: PushMessage,
  vapid: VapidKeys,
  opts: { subject: string; fetch?: typeof fetch }
): Promise<PushOutcome> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const body = encryptPayload(
      Buffer.from(JSON.stringify(message.payload), 'utf8'),
      subscription.keys
    );
    const response = await doFetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(
          subscription.endpoint,
          vapid,
          opts.subject
        ),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(message.ttlSeconds ?? 24 * 3600),
        urgency: 'high',
        ...(message.topic === undefined ? {} : { topic: message.topic }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 410)
      return { kind: 'gone' };
    if (!response.ok)
      return {
        kind: 'failed',
        status: response.status,
        error: (await response.text().catch(() => '')).slice(0, 200),
      };
    return { kind: 'sent' };
  } catch (err) {
    return { kind: 'failed', status: null, error: (err as Error).message };
  }
}
