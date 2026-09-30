import type { ApiContext } from '../api.js';
import { WEBHOOK_MAX_BYTES } from '../linear/webhook.js';
import { errorResponse, jsonResponse } from './http.js';

/** Whether a request is the one route Linear delivers to. */
export function isLinearWebhook(method: string, segments: string[]): boolean {
  return (
    method === 'POST' &&
    segments.length === 2 &&
    segments[0] === 'linear' &&
    segments[1] === 'webhook'
  );
}

// The body as text, or null once it passes `max` bytes. Read in chunks so a
// delivery with no content-length is cut off at the cap, not buffered whole.
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * POST /api/linear/webhook — Linear's deliveries. It carries no daemon token
 * (Linear has none to send), so it is admitted by its exact path alone and
 * trusted only once the `Linear-Signature` HMAC over the raw body checks out
 * against the secret this daemon registered; LinearSync.handleWebhook does
 * that check before anything else. Bodies are capped before they are read.
 */
export async function linearWebhook(
  req: Request,
  ctx: Pick<ApiContext, 'linearSync'>
): Promise<Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) {
    return errorResponse(413, 'delivery too large');
  }
  const raw = await readCapped(req, WEBHOOK_MAX_BYTES);
  if (raw === null) return errorResponse(413, 'delivery too large');
  const reply = ctx.linearSync.handleWebhook(
    raw,
    req.headers.get('linear-signature')
  );
  return jsonResponse(reply.body, reply.status);
}
