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
  const headers = new Headers(res.headers);
  let bytes: Uint8Array | null = null;
  if (!stream) {
    // A string or JSON body's type is only set when sent; set it now so the
    // signature covers the header the client will see.
    const blob = await res.blob();
    bytes = new Uint8Array(await blob.arrayBuffer());
    if (!headers.has('content-type') && bytes.length > 0)
      headers.set(
        'content-type',
        blob.type === '' ? 'application/octet-stream' : blob.type
      );
  }
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
