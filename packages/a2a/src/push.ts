import type { JsonValue } from '@dispatch-foo/protocol';
import { MessagingError } from '@dispatch-foo/protocol';

import { utf8Bytes } from './ext.js';
import type { GuardOptions } from './peer/guard.js';
import { peerFetch, PeerHttpError } from './peer/http.js';
import type { StreamResponseJson } from './wire.js';

// A push config as a client sent it (a2a.proto v1.0.1 TaskPushNotificationConfig).
export interface PushAuth {
  scheme: string;
  credentials?: string;
}
export interface PushConfigJson {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: PushAuth;
}
export interface PushConfigInput {
  id: string | null;
  url: string;
  token?: string;
  authentication?: PushAuth;
}

export const PUSH_LIMITS = {
  perTask: 3,
  perClient: 50,
  failuresBeforeDisable: 10,
  retryDelaysMs: [10_000, 60_000, 300_000],
  timeoutMs: 10_000,
} as const;

/** The SDK's default header for a config's token (@a2a-js/sdk 1.2.0). */
export const PUSH_TOKEN_HEADER = 'X-A2A-Notification-Token';

const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
// One header value: visible ASCII, no spaces.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

type TextRule = 'line' | 'header';

// A string field: absent when missing or empty, else one line (or, for a
// value that goes in a header, visible ASCII) of at most `maxBytes`. The
// error never quotes the value, which may be a secret.
function text(
  raw: unknown,
  field: string,
  maxBytes: number,
  rule: TextRule = 'line'
): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const ok =
    typeof raw === 'string' &&
    utf8Bytes(raw) <= maxBytes &&
    (rule === 'header' ? VISIBLE_ASCII.test(raw) : !LINE_BREAK.test(raw));
  if (!ok)
    throw new MessagingError(
      'invalid',
      rule === 'header'
        ? `${field}: visible ASCII with no spaces, at most ${maxBytes} bytes`
        : `${field}: one line of at most ${maxBytes} bytes`,
      field
    );
  return raw;
}

/** A client's push config; the host guards the URL's address. */
export function parsePushConfig(raw: unknown): PushConfigInput {
  const r = (
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  ) as Record<string, unknown>;
  const url = text(r.url, 'url', 2048);
  if (url === undefined)
    throw new MessagingError('invalid', 'url: required', 'url');
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new MessagingError('invalid', 'url: not a URL', 'url');
  }
  if (protocol !== 'https:' && protocol !== 'http:')
    throw new MessagingError(
      'invalid',
      'url: must be an http or https URL',
      'url'
    );
  const out: PushConfigInput = { id: text(r.id, 'id', 128) ?? null, url };
  const token = text(r.token, 'token', 512, 'header');
  if (token !== undefined) out.token = token;
  const auth = r.authentication;
  if (auth !== undefined && auth !== null) {
    const a = (typeof auth === 'object' ? auth : {}) as Record<string, unknown>;
    const scheme = text(a.scheme, 'authentication.scheme', 64, 'header');
    if (scheme === undefined)
      throw new MessagingError(
        'invalid',
        'authentication.scheme: required',
        'authentication.scheme'
      );
    const credentials = text(
      a.credentials,
      'authentication.credentials',
      4096,
      'header'
    );
    out.authentication = {
      scheme,
      ...(credentials === undefined ? {} : { credentials }),
    };
  }
  return out;
}

/** A config as a client reads it back: never its token or credentials. */
export function pushConfigJson(c: PushConfigJson): Record<string, JsonValue> {
  return {
    id: c.id,
    taskId: c.taskId,
    url: c.url,
    ...(c.authentication === undefined
      ? {}
      : { authentication: { scheme: c.authentication.scheme } }),
  };
}

export function pushHeaders(config: PushConfigJson): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const auth = config.authentication;
  if (auth !== undefined)
    headers.authorization =
      auth.credentials === undefined
        ? auth.scheme
        : `${auth.scheme} ${auth.credentials}`;
  if (config.token !== undefined) headers[PUSH_TOKEN_HEADER] = config.token;
  return headers;
}

export type PushResult =
  | { ok: true }
  // `refused`: the guard refused the address; final, unlike a network error.
  | { ok: false; status: number | null; refused: boolean; error: string };

// One attempt: POST one StreamResponse with no redirects, a 10 s deadline and,
// with `guard`, re-resolved and pinned to a public address (spec:1781-1786).
// Errors are generic so a token or credential never reaches a log.
export type DeliverOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} & (
  | { guard: GuardOptions; unguarded?: never }
  // Only for a webhook on this machine that a test or the TCK runs.
  | { unguarded: true; guard?: never }
);

export async function deliverPush(
  config: PushConfigJson,
  event: StreamResponseJson,
  o: DeliverOptions
): Promise<PushResult> {
  // The type demands one of the two; a caller that slipped past it fails loudly.
  if (o.guard === undefined && o.unguarded !== true)
    throw new Error('deliverPush needs a guard, or unguarded: true');
  try {
    const res = await peerFetch({
      headers: pushHeaders(config),
      timeoutMs: o.timeoutMs ?? PUSH_LIMITS.timeoutMs,
      maxBodyBytes: 64 * 1024,
      ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
      ...(o.guard === undefined ? {} : { guard: { field: 'url', ...o.guard } }),
    })(config.url, {
      method: 'POST',
      body: JSON.stringify(event as unknown as JsonValue),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok
      ? { ok: true }
      : {
          ok: false,
          status: res.status,
          refused: false,
          error: `the webhook answered HTTP ${res.status}`,
        };
  } catch (err) {
    if (err instanceof PeerHttpError) {
      const refused = err.reason === 'ADDRESS_REFUSED';
      return {
        ok: false,
        status: err.status,
        refused,
        error: refused
          ? 'the webhook address is refused'
          : err.status === null
            ? 'the webhook could not be reached'
            : `the webhook answered HTTP ${err.status}`,
      };
    }
    return {
      ok: false,
      status: null,
      refused: false,
      error: 'the webhook could not be reached',
    };
  }
}
