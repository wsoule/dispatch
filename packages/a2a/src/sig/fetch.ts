import { MAX_CLOCK_LEAD_MS } from '@dispatch/protocol/federation';
import type { KeyObject } from 'node:crypto';

import { PeerHttpError } from '../peer/http.js';
import type { StatusBox } from '../peer/http.js';
import { ecThumbprint } from './keys.js';
import { signRequest } from './sign.js';
import { verifyResponse } from './verify.js';

export interface SignedFetchOptions {
  // This project's card key.
  keyid: string;
  privateKey: KeyObject;
  // The peer's card key, pinned at pairing.
  peerKey: KeyObject;
  now?: () => Date;
  // The peer client's status box: a refused reply records 401 there too, in
  // case the SDK wraps the thrown error.
  box?: StatusBox;
}

// An event stream is signed over its headers; its events ride TLS (OD-4).
export function isEventStream(headers: Headers): boolean {
  return (headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('text/event-stream');
}

function bodyBytes(body: unknown): Uint8Array | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError('a signed request needs a string or byte body');
}

/**
 * A fetch that signs every request with this project's card key (RFC 9421)
 * and accepts only responses the pinned peer key signed for that request. An
 * unverifiable response is a retryable PeerHttpError (status null) with the
 * refusal class as its reason; only a verified reply can refuse a credential. It wraps the peer fetch from outside, so it signs the URL the
 * peer was told to serve, never a pinned address.
 */
export function signedFetch(
  inner: typeof fetch,
  o: SignedFetchOptions
): typeof fetch {
  const peerKeyid = ecThumbprint(
    o.peerKey.export({ format: 'jwk' }) as Record<string, unknown>
  );
  const call = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    if (input instanceof Request)
      throw new TypeError('signedFetch takes a URL and init');
    const targetUri = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    headers.set('a2a-version', '1.0');
    const body = bodyBytes(init?.body);
    const now = o.now?.() ?? new Date();
    const signed = signRequest({
      method,
      targetUri,
      headers,
      body,
      keyid: o.keyid,
      privateKey: o.privateKey,
      now,
    });
    for (const [name, value] of Object.entries(signed))
      headers.set(name, value);
    // An error the inner fetch threw with a status (an unfollowed redirect,
    // an oversized body) came from a reply nobody verified: unverifiable,
    // never a credential verdict (review N1/N7).
    const unverified = (reason: string, message: string): PeerHttpError => {
      if (o.box !== undefined) {
        o.box.status = null;
        o.box.reason = reason;
        o.box.network = true;
      }
      return new PeerHttpError(null, message, null, reason);
    };
    let res: Response;
    try {
      res = await inner(targetUri, {
        ...init,
        method,
        headers,
        ...(body === null ? {} : { body }),
      });
    } catch (err) {
      if (err instanceof PeerHttpError && err.status !== null)
        throw unverified(
          'sig_missing',
          `the peer's reply could not be verified (${err.message})`
        );
      throw err;
    }
    const stream = isEventStream(res.headers);
    let bytes: Uint8Array | null = null;
    if (!stream) {
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        // A body over the cap, cut off before it could be verified.
        if (err instanceof PeerHttpError)
          throw unverified(
            'sig_missing',
            `the peer's reply could not be verified (${err.message})`
          );
        throw err;
      }
    }
    const verdict = verifyResponse(
      { status: res.status, headers: res.headers, body: bytes },
      { method, targetUri, headers },
      {
        keyFor: (id) => (id === peerKeyid ? o.peerKey : null),
        now: o.now?.() ?? new Date(),
        guardMs: MAX_CLOCK_LEAD_MS,
      }
    );
    // Unverifiable is never a credential verdict: a proxy's 502, a peer's
    // stale clock or a stripped header retries like a network fault.
    if (!verdict.ok)
      throw unverified(
        verdict.reason,
        `the peer's reply could not be verified (${verdict.reason})`
      );
    return new Response(stream ? res.body : bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  return call as typeof fetch;
}
