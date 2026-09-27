import { DOCS_LIMITS } from '@dispatch/core';

import { errorResponse, requireJsonContentType } from '../api/http.js';

// Reads a request body without ever holding more than `maxBytes` of it.
export async function readBoundedBytes(
  req: Request,
  maxBytes: number
): Promise<Uint8Array | Response> {
  const tooLarge = (): Response =>
    errorResponse(413, `request body over ${maxBytes} bytes`);
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// A JSON object body under the docs bound; an empty body reads as {}.
export async function readBoundedJson(
  req: Request,
  maxBytes: number = DOCS_LIMITS.requestBytes
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const rejected = requireJsonContentType(req);
  if (rejected !== null) return { ok: false, response: rejected };
  const bytes = await readBoundedBytes(req, maxBytes);
  if (bytes instanceof Response) return { ok: false, response: bytes };
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '') return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      response: errorResponse(400, 'invalid body: expected a JSON object'),
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
