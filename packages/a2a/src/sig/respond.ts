import type { KeyObject } from 'node:crypto';

import type { RequestParts } from './base.js';
import { isEventStream } from './fetch.js';
import { signResponse } from './sign.js';

/**
 * `res` signed for the request it answers: a stream over its headers (its
 * events ride TLS, OD-4), anything else over its body as well.
 */
export async function signResponseFor(
  res: Response,
  request: RequestParts,
  signer: { keyid: string; privateKey: KeyObject },
  now = new Date()
): Promise<Response> {
  const stream = isEventStream(res.headers);
  const bytes = stream ? null : new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  const signed = signResponse({
    status: res.status,
    headers,
    body: bytes,
    request,
    keyid: signer.keyid,
    privateKey: signer.privateKey,
    now,
  });
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return new Response(stream ? res.body : bytes, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
