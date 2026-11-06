import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  concatBytes,
  fromBase64Url,
  toBase64Url,
  utf8Encode,
} from './bytes.js';

// The end-to-end handshake between a phone and its daemon, run through the
// relay, which only ever sees the two public messages below and ciphertext.
//
// Each side holds a long-term X25519 key: the daemon's reaches the phone in
// the pairing QR code, the phone's is registered with the daemon at pairing.
// A session adds one ephemeral key per side and mixes three Diffie-Hellman
// results, the shape of Noise's KK pattern:
//
//   ee = DH(phone ephemeral, daemon ephemeral)   forward secrecy
//   es = DH(phone ephemeral, daemon static)      only the real daemon can derive it
//   se = DH(phone static, daemon ephemeral)      only the paired phone can derive it
//
// While pairing, the one-time code from the QR code is mixed in too, so only
// a phone that scanned the code can finish; the daemon then records that
// phone's static key and burns the code. Session keys come out of HKDF over
// all of it, salted with a hash of every public key involved, so a relay that
// swaps any key gets two sides holding different keys and nothing decrypts.

export const PROTOCOL = 'dispatch-remote/1';

const KEY_BYTES = 32;
const ZERO_PSK = new Uint8Array(KEY_BYTES);

/** An X25519 key pair. */
export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Source of randomness. The daemon passes nothing (WebCrypto is there); the
 *  app passes expo-crypto's, since Hermes has no global `crypto`. */
export type RandomBytes = (length: number) => Uint8Array;

export function defaultRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A fresh key pair from `random`'s bytes. */
export function generateKeyPair(random: RandomBytes = defaultRandom): KeyPair {
  const secretKey = random(KEY_BYTES);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The public half of a stored secret key. */
export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** The phone's opening message, in the clear. */
export interface Hello {
  t: 'hello';
  v: 1;
  /** Phone ephemeral public key. */
  e: string;
  /** Phone static public key. */
  s: string;
  /** The daemon static key the phone expects, so a rotated key fails fast. */
  d: string;
  /** Set while pairing: which offer's code was mixed in. Not the code. */
  pair?: string;
  /** While pairing: what the phone calls itself, shown in the device list. */
  name?: string;
}

/** The daemon's answer, in the clear. */
export interface Welcome {
  t: 'welcome';
  e: string;
}

/** The daemon turning a hello away, in the clear. */
export interface Reject {
  t: 'reject';
  reason: 'unknown-device' | 'pairing-expired' | 'wrong-daemon' | 'malformed';
}

/** Both directions' keys for one session. */
export interface SessionKeys {
  send: Uint8Array;
  receive: Uint8Array;
}

function deriveKeys(input: {
  ee: Uint8Array;
  es: Uint8Array;
  se: Uint8Array;
  psk: Uint8Array;
  daemonStatic: Uint8Array;
  phoneStatic: Uint8Array;
  phoneEphemeral: Uint8Array;
  daemonEphemeral: Uint8Array;
}): { phoneToDaemon: Uint8Array; daemonToPhone: Uint8Array } {
  const transcript = sha256(
    concatBytes(
      utf8Encode(PROTOCOL),
      input.daemonStatic,
      input.phoneStatic,
      input.phoneEphemeral,
      input.daemonEphemeral
    )
  );
  const okm = hkdf(
    sha256,
    concatBytes(input.ee, input.es, input.se, input.psk),
    transcript,
    utf8Encode(`${PROTOCOL} session keys`),
    KEY_BYTES * 2
  );
  return {
    phoneToDaemon: okm.slice(0, KEY_BYTES),
    daemonToPhone: okm.slice(KEY_BYTES),
  };
}

function decodeKey(text: unknown): Uint8Array | null {
  if (typeof text !== 'string') return null;
  try {
    const key = fromBase64Url(text);
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** The phone's side, from its hello to its keys. */
export class PhoneHandshake {
  private readonly ephemeral: KeyPair;
  readonly hello: Hello;

  constructor(
    private readonly phone: KeyPair,
    private readonly daemonStatic: Uint8Array,
    private readonly pairing: {
      offerId: string;
      code: Uint8Array;
      name: string;
    } | null,
    random: RandomBytes = defaultRandom
  ) {
    this.ephemeral = generateKeyPair(random);
    this.hello = {
      t: 'hello',
      v: 1,
      e: toBase64Url(this.ephemeral.publicKey),
      s: toBase64Url(phone.publicKey),
      d: toBase64Url(daemonStatic),
      ...(pairing === null
        ? {}
        : { pair: pairing.offerId, name: pairing.name }),
    };
  }

  /** The session keys, once the daemon's welcome arrives. */
  finish(welcome: Welcome): SessionKeys {
    const daemonEphemeral = decodeKey(welcome.e);
    if (daemonEphemeral === null) throw new Error('malformed welcome');
    const keys = deriveKeys({
      ee: x25519.getSharedSecret(this.ephemeral.secretKey, daemonEphemeral),
      es: x25519.getSharedSecret(this.ephemeral.secretKey, this.daemonStatic),
      se: x25519.getSharedSecret(this.phone.secretKey, daemonEphemeral),
      psk: this.pairing?.code ?? ZERO_PSK,
      daemonStatic: this.daemonStatic,
      phoneStatic: this.phone.publicKey,
      phoneEphemeral: this.ephemeral.publicKey,
      daemonEphemeral,
    });
    return { send: keys.phoneToDaemon, receive: keys.daemonToPhone };
  }
}

/** A hello the daemon could parse, with its keys decoded. */
export interface ParsedHello {
  phoneStatic: Uint8Array;
  phoneEphemeral: Uint8Array;
  expectedDaemon: Uint8Array;
  pair: string | null;
  name: string | null;
}

/** Reads a hello off the wire, or null when it is not one. */
export function parseHello(value: unknown): ParsedHello | null {
  if (typeof value !== 'object' || value === null) return null;
  const h = value as Partial<Hello>;
  if (h.t !== 'hello' || h.v !== 1) return null;
  const phoneStatic = decodeKey(h.s);
  const phoneEphemeral = decodeKey(h.e);
  const expectedDaemon = decodeKey(h.d);
  if (
    phoneStatic === null ||
    phoneEphemeral === null ||
    expectedDaemon === null
  )
    return null;
  const pair = typeof h.pair === 'string' && h.pair !== '' ? h.pair : null;
  const trimmed = typeof h.name === 'string' ? h.name.slice(0, 64).trim() : '';
  const name = trimmed === '' ? null : trimmed;
  return { phoneStatic, phoneEphemeral, expectedDaemon, pair, name };
}

/** The daemon's side: its welcome and its keys, from a parsed hello. `psk` is
 *  the pairing code when the hello is pairing, else null. */
export function answerHello(
  daemon: KeyPair,
  hello: ParsedHello,
  psk: Uint8Array | null,
  random: RandomBytes = defaultRandom
): { welcome: Welcome; keys: SessionKeys } {
  const ephemeral = generateKeyPair(random);
  const keys = deriveKeys({
    ee: x25519.getSharedSecret(ephemeral.secretKey, hello.phoneEphemeral),
    es: x25519.getSharedSecret(daemon.secretKey, hello.phoneEphemeral),
    se: x25519.getSharedSecret(ephemeral.secretKey, hello.phoneStatic),
    psk: psk ?? ZERO_PSK,
    daemonStatic: daemon.publicKey,
    phoneStatic: hello.phoneStatic,
    phoneEphemeral: hello.phoneEphemeral,
    daemonEphemeral: ephemeral.publicKey,
  });
  return {
    welcome: { t: 'welcome', e: toBase64Url(ephemeral.publicKey) },
    keys: { send: keys.daemonToPhone, receive: keys.phoneToDaemon },
  };
}

/**
 * One direction's AEAD. Nonces are a counter, never sent: the relay carries a
 * WebSocket, which delivers in order, so a dropped, repeated or reordered
 * frame fails to open and the session ends rather than resynchronising.
 */
class DirectionalCipher {
  private counter = 0;

  constructor(private readonly key: Uint8Array) {}

  private nextNonce(): Uint8Array {
    if (this.counter >= Number.MAX_SAFE_INTEGER)
      throw new Error('session exhausted');
    const nonce = new Uint8Array(12);
    let n = this.counter++;
    for (let i = 11; i >= 4; i--) {
      nonce[i] = n % 256;
      n = Math.floor(n / 256);
    }
    return nonce;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    return chacha20poly1305(this.key, this.nextNonce()).encrypt(plaintext);
  }

  open(ciphertext: Uint8Array): Uint8Array {
    return chacha20poly1305(this.key, this.nextNonce()).decrypt(ciphertext);
  }
}

/** Encrypts outgoing and decrypts incoming frames for one session. `open`
 *  throws on any frame that was tampered with, replayed or reordered. */
export class SessionCipher {
  private readonly out: DirectionalCipher;
  private readonly in: DirectionalCipher;

  constructor(keys: SessionKeys) {
    this.out = new DirectionalCipher(keys.send);
    this.in = new DirectionalCipher(keys.receive);
  }

  seal(plaintext: Uint8Array): Uint8Array {
    return this.out.seal(plaintext);
  }

  open(ciphertext: Uint8Array): Uint8Array {
    return this.in.open(ciphertext);
  }
}

/** What a phone shows to tell this daemon's key apart: the first 8 bytes of
 *  its hash as hex groups. */
export function fingerprint(publicKey: Uint8Array): string {
  const digest = sha256(publicKey);
  const hex = Array.from(digest.slice(0, 8), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return hex.match(/.{4}/g)?.join('-') ?? hex;
}
