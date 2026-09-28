// Linear webhook deliveries: signature and freshness checks, payload parsing,
// and where a reachable daemon asks Linear to deliver.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Deliveries older (or newer) than this against our clock are refused. */
const FRESH_WINDOW_MS = 60_000;

/** The largest delivery body the route reads. */
export const WEBHOOK_MAX_BYTES = 1_000_000;

/** The kinds of change the webhook subscribes to (Linear's documented set). */
export const WEBHOOK_RESOURCE_TYPES = [
  'Issue',
  'Comment',
  'IssueLabel',
  'Project',
  'Cycle',
];

const WEBHOOK_PATH = '/api/linear/webhook';

/**
 * Whether `signature` (the `Linear-Signature` header) is the hex HMAC-SHA256
 * of the raw body under `secret`. Compared in constant time; anything that is
 * not 64 hex characters fails before the comparison.
 */
export function verifyLinearSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (signature === null || !/^[0-9a-f]{64}$/i.test(signature.trim())) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Whether a delivery's `webhookTimestamp` (epoch ms) is within a minute of now. */
export function webhookFresh(timestamp: unknown, now: number): boolean {
  return (
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    Math.abs(now - timestamp) <= FRESH_WINDOW_MS
  );
}

/** The part of a delivery the sync acts on. */
export interface WebhookEvent {
  action: 'create' | 'update' | 'remove';
  /** The entity type, e.g. `Issue` or `Comment`. */
  type: string;
  id: string;
  updatedAt: string | null;
  webhookTimestamp: unknown;
}

/** A delivery body as a WebhookEvent, or null when it is not one. */
export function parseWebhook(raw: string): WebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  if (
    (b.action !== 'create' && b.action !== 'update' && b.action !== 'remove') ||
    typeof b.type !== 'string' ||
    typeof data !== 'object' ||
    data === null ||
    typeof data.id !== 'string'
  ) {
    return null;
  }
  return {
    action: b.action,
    type: b.type,
    id: data.id,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    webhookTimestamp: b.webhookTimestamp,
  };
}

// Hosts Linear can never reach, so no webhook is registered against them.
function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/**
 * Where Linear should deliver, from the daemon's public origins: the first
 * https origin on a host the internet can reach. Null when there is none,
 * which leaves the sync polling.
 */
export function webhookUrlFor(origins: readonly string[]): string | null {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || isLocalHost(url.hostname)) continue;
    return `${url.origin}${WEBHOOK_PATH}`;
  }
  return null;
}
