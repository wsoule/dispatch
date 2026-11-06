// A minimal GraphQL client for Linear over plain fetch (no SDK at runtime).
// It owns transport concerns only: auth header, retries with bounded backoff
// (rate limits honour Linear's reset headers), and mapping every failure to a
// LinearApiError kind the engine can act on. Credentials never reach the
// logs or the errors: an OAuth token is sent as `Bearer <token>`, a personal
// API key raw (architecture §4.1 "Personal API keys", F1), and every text a
// failure carries (the fetch error, Linear's own messages) is scrubbed of
// the credential sent and of anything credential-shaped first.

import { LinearApiError } from './gateway.js';
import {
  arrayAt,
  isRecord,
  type JsonObject,
  optionalObject,
  optionalString,
} from './json.js';
import { redactLinearSecrets } from './secrets.js';

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** The fetch surface this package needs; the global fetch satisfies it. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Structural subset of @better-tracker/logger's Logger. */
export interface LinearLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface GraphqlClientOptions {
  /**
   * An OAuth access token, sent as `Bearer <token>`. Exactly one of
   * accessToken and apiKey.
   */
  accessToken?: string;
  /**
   * A personal API key's getter, read before every attempt (the first try,
   * each retry, after each rate-limit wait) and sent raw, without `Bearer`
   * (F1). Returning null fails the request at once as `unauthorized`: the
   * key was forgotten, so work already running stops using it. The client
   * never keeps what it returns. Exactly one of accessToken and apiKey.
   */
  apiKey?: () => string | null;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Defaults to https://api.linear.app/graphql. */
  endpoint?: string;
  logger?: LinearLogger;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Clock in epoch ms, for computing waits until rate-limit resets. */
  now?: () => number;
  /**
   * Longest single wait for a rate-limit reset (default 60 s). A reset
   * further away fails fast with `rate_limited` + `retryAt` instead of
   * holding a request (or a webhook handler) open.
   */
  maxRateLimitWaitMs?: number;
  /** Per-attempt timeout (default 30 s). */
  timeoutMs?: number;
}

interface GraphqlRequestOptions {
  /**
   * False for mutations that must not run twice (commentCreate): server and
   * network failures are then not retried, because the first attempt may
   * have been applied. Rate-limited requests are always retried since Linear
   * rejects them before executing anything. Defaults to true.
   */
  idempotent?: boolean;
}

export interface GraphqlClient {
  request<T>(
    query: string,
    variables?: Record<string, unknown>,
    options?: GraphqlRequestOptions
  ): Promise<T>;
}

/** One entry of a GraphQL `errors` array, narrowed. */
export interface GraphqlErrorInfo {
  message: string;
  /** Response path, e.g. `["i3", "stateHistory"]` for an aliased field. */
  path: (string | number)[];
  /** `extensions.code`, e.g. RATELIMITED, INPUT_ERROR. */
  code: string | null;
  /** `extensions.type`, e.g. "ratelimited", "invalid input". */
  type: string | null;
  userPresentableMessage: string | null;
}

/**
 * Attached as `cause` of a LinearApiError raised for GraphQL errors, so
 * callers (e.g. aliased batches) can see which response paths failed.
 */
export class LinearGraphqlErrors extends Error {
  readonly errors: readonly GraphqlErrorInfo[];

  constructor(errors: readonly GraphqlErrorInfo[]) {
    super(errors[0]?.message ?? 'GraphQL error');
    this.name = 'LinearGraphqlErrors';
    this.errors = errors;
  }
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** Added to a reset wait so the retry lands after the window rolls over. */
const RESET_MARGIN_MS = 250;

const noopLogger: LinearLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for attempt 0, 1, 2… capped at BACKOFF_CAP_MS. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

// Pulls the operation name out of a document ("query Issue(…)" → "Issue")
// so logs and errors say which call failed without echoing variables.
export function operationName(query: string): string {
  const match = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match?.[2] ?? 'anonymous';
}

// Narrows a response body's `errors` array; anything that is not an object
// with a message is skipped rather than trusted. `scrub` cleans every text
// Linear returned (the client passes its credential scrubber).
export function parseGraphqlErrors(
  body: unknown,
  scrub: (text: string) => string = redactLinearSecrets
): GraphqlErrorInfo[] {
  if (!isRecord(body)) return [];
  const out: GraphqlErrorInfo[] = [];
  for (const raw of arrayAt(body, 'errors')) {
    if (!isRecord(raw)) continue;
    const extensions: JsonObject = optionalObject(raw, 'extensions') ?? {};
    const path = arrayAt(raw, 'path').filter(
      (part): part is string | number =>
        typeof part === 'string' || typeof part === 'number'
    );
    const presentable = optionalString(extensions, 'userPresentableMessage');
    out.push({
      message: scrub(optionalString(raw, 'message') ?? 'Unknown GraphQL error'),
      path,
      code: optionalString(extensions, 'code'),
      type: optionalString(extensions, 'type'),
      userPresentableMessage: presentable === null ? null : scrub(presentable),
    });
  }
  return out;
}

function hasCode(error: GraphqlErrorInfo, codes: readonly string[]): boolean {
  return error.code !== null && codes.includes(error.code.toUpperCase());
}

function hasType(error: GraphqlErrorInfo, types: readonly string[]): boolean {
  return error.type !== null && types.includes(error.type.toLowerCase());
}

/** Linear's rate-limit signal (the SDK checks both code and type). */
function isRateLimitError(error: GraphqlErrorInfo): boolean {
  return hasCode(error, ['RATELIMITED']) || hasType(error, ['ratelimited']);
}

const NOT_FOUND_PATTERN = /\bentity not found\b|\bnot found\b|could not find/i;

// Classifies GraphQL errors (data null) into the gateway's error kinds.
// Not-found is checked before invalid input because Linear reports a
// missing entity as an "invalid input" error whose message says so.
export function classifyGraphqlErrors(
  errors: readonly GraphqlErrorInfo[]
): LinearApiError['kind'] {
  if (errors.some(isRateLimitError)) return 'rate_limited';
  if (
    errors.some(
      (e) =>
        hasCode(e, ['AUTHENTICATION_ERROR', 'UNAUTHENTICATED']) ||
        hasType(e, ['authentication error'])
    )
  ) {
    return 'unauthorized';
  }
  if (
    errors.some((e) => hasCode(e, ['FORBIDDEN']) || hasType(e, ['forbidden']))
  )
    return 'forbidden';
  // Only a root-level error (no path, or the queried root/alias field)
  // means the entity itself is missing. A "not found" from a nested field
  // must not read as "gone", or the engine would drop a live entity from
  // the mirror until the next resync.
  if (
    errors.some(
      (e) =>
        e.path.length <= 1 &&
        (hasCode(e, ['NOT_FOUND', 'ENTITY_NOT_FOUND']) ||
          NOT_FOUND_PATTERN.test(e.message) ||
          (e.userPresentableMessage !== null &&
            NOT_FOUND_PATTERN.test(e.userPresentableMessage)))
    )
  ) {
    return 'not_found';
  }
  if (
    errors.some(
      (e) =>
        hasCode(e, [
          'INPUT_ERROR',
          'BAD_USER_INPUT',
          'GRAPHQL_VALIDATION_FAILED',
          'GRAPHQL_PARSE_FAILED',
        ]) || hasType(e, ['invalid input', 'user error'])
    )
  ) {
    return 'invalid_input';
  }
  return 'graphql';
}

function parseEpochMs(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A `remaining` count; null when the header is absent or not a number.
function parseCount(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Retry-After as an instant in epoch ms: delay-seconds (what the SDK
// reads) or an HTTP date. Null when absent or unreadable.
function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return nowMs + Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : date;
}

/**
 * When Linear says the refused request may be retried, in epoch ms, or
 * null (the caller then backs off). In order: `Retry-After` (seconds or a
 * date; the official SDK reads it); the endpoint window
 * (`x-ratelimit-endpoint-requests-*`, Linear's per-endpoint limit) when it
 * is used up; else the latest reset of the global windows (requests,
 * complexity) that are used up. A window that still has requests left
 * did not cause the refusal, so its reset is never used; a reset sent
 * without a `remaining` count counts as used up.
 */
export function rateLimitResetMs(
  headers: Headers,
  nowMs: number
): number | null {
  const retryAfter = retryAfterMs(headers.get('retry-after'), nowMs);
  if (retryAfter !== null) return Math.max(retryAfter, nowMs);

  const exhausted = (prefix: string): number | null => {
    const reset = parseEpochMs(headers.get(`${prefix}-reset`));
    const remaining = parseCount(headers.get(`${prefix}-remaining`));
    return reset !== null && (remaining === null || remaining <= 0)
      ? reset
      : null;
  };
  const endpoint = exhausted('x-ratelimit-endpoint-requests');
  if (endpoint !== null) return endpoint;

  let latest: number | null = null;
  for (const prefix of [
    'x-ratelimit-requests',
    'x-ratelimit-complexity',
  ] as const) {
    const reset = exhausted(prefix);
    if (reset !== null && (latest === null || reset > latest)) latest = reset;
  }
  return latest;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * What an HTTP header value may hold here: printable ASCII, with at most
 * the one space after `Bearer`. Checked before every fetch, because Node
 * (undici) and Bun echo an invalid header's value in their error (F11).
 */
const SAFE_AUTHORIZATION = /^[\x21-\x7e]+(?: [\x21-\x7e]+)?$/;

/** Shortest prefix-less tail of a credential that is worth scrubbing. */
const MIN_SCRUBBED_TAIL = 16;

/**
 * The text of a failure with the credential sent on this attempt replaced
 * by `[redacted]`, then every credential-shaped run (core's
 * redactLinearSecrets), so neither an echoed key nor an echoed OAuth token
 * reaches an error message or a log. The credential's secret part without
 * its `lin_api_` / `lin_oauth_` prefix is scrubbed too: an answer that
 * quoted only that part would otherwise slip past both, and a sync failure's
 * text is kept in the store.
 */
function scrubber(credential: string): (text: string) => string {
  const tail = credential.replace(/^lin_(?:api|oauth)_/, '');
  const secrets = [credential];
  if (tail !== credential && tail.length >= MIN_SCRUBBED_TAIL) {
    secrets.push(tail);
  }
  return (text: string): string => {
    if (credential === '') return redactLinearSecrets(text);
    let scrubbed = text;
    for (const secret of secrets) {
      scrubbed = scrubbed.replaceAll(secret, '[redacted]');
    }
    return redactLinearSecrets(scrubbed);
  };
}

/**
 * Creates a client bound to one credential: an OAuth access token, or a
 * personal API key read through a getter. A personal key is read through
 * `apiKey()` before each attempt and lives only in the caller's store of
 * keys; nothing this client returns, logs or throws contains it.
 */
export function createGraphqlClient(
  options: GraphqlClientOptions
): GraphqlClient {
  const hasToken = typeof options.accessToken === 'string';
  const hasKey = typeof options.apiKey === 'function';
  if (hasToken === hasKey) {
    throw new Error(
      'createGraphqlClient needs exactly one of accessToken or apiKey'
    );
  }
  const accessToken = options.accessToken;
  const apiKey = options.apiKey;
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
  const logger = options.logger ?? noopLogger;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const now = options.now ?? Date.now;
  const maxRateLimitWaitMs =
    options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The credential for one attempt and its Authorization value, or null
  // when the key getter has nothing (forgotten).
  function credentialForAttempt(): {
    credential: string;
    authorization: string;
  } | null {
    if (apiKey !== undefined) {
      const key = apiKey();
      if (typeof key !== 'string' || key === '') return null;
      return { credential: key, authorization: key };
    }
    const token = accessToken ?? '';
    return { credential: token, authorization: `Bearer ${token}` };
  }

  async function request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    requestOptions: GraphqlRequestOptions = {}
  ): Promise<T> {
    const op = operationName(query);
    const idempotent = requestOptions.idempotent ?? true;
    const body = JSON.stringify({ query, variables });

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;
      const held = credentialForAttempt();
      if (held === null) {
        throw new LinearApiError(
          'unauthorized',
          `No Linear credential is held for ${op}`
        );
      }
      if (!SAFE_AUTHORIZATION.test(held.authorization)) {
        throw new LinearApiError(
          'unauthorized',
          'The Linear credential has characters an HTTP header cannot carry.'
        );
      }
      const scrub = scrubber(held.credential);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: held.authorization,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          // Never in Next's Data Cache, and a redirect must not resend the
          // body (and with it the request) anywhere else (F14).
          cache: 'no-store',
          redirect: 'error',
        });
      } catch (cause) {
        const described = scrub(describeCause(cause));
        if (idempotent && canRetry) {
          const waitMs = backoffMs(attempt);
          logger.warn('linear request failed; retrying', {
            operation: op,
            attempt,
            waitMs,
            error: described,
          });
          await sleep(waitMs);
          continue;
        }
        // Never the raw fetch error: its message or a nested cause could
        // carry the credential (F11). Only the scrubbed text and its name.
        throw new LinearApiError(
          'network',
          `Linear ${op} request failed: ${described}`,
          {
            cause: Object.assign(new Error(described), {
              name: cause instanceof Error ? scrub(cause.name) : 'Error',
            }),
          }
        );
      }

      const status = response.status;
      const json = await readJsonBody(response);
      const errors = parseGraphqlErrors(json, scrub);

      // Rate limiting arrives as HTTP 429, or HTTP 400 with RATELIMITED.
      if (status === 429 || errors.some(isRateLimitError)) {
        const resetMs = rateLimitResetMs(response.headers, now());
        const retryAt =
          resetMs === null ? null : new Date(resetMs).toISOString();
        const waitMs =
          resetMs === null
            ? backoffMs(attempt)
            : Math.max(0, resetMs - now()) + RESET_MARGIN_MS;
        if (canRetry && waitMs <= maxRateLimitWaitMs) {
          logger.warn('linear rate limited; waiting for reset', {
            operation: op,
            attempt,
            waitMs,
            retryAt,
          });
          await sleep(waitMs);
          continue;
        }
        throw new LinearApiError(
          'rate_limited',
          `Linear rate limit reached during ${op}`,
          { retryAt, cause: new LinearGraphqlErrors(errors) }
        );
      }

      if (status === 401) {
        throw new LinearApiError(
          'unauthorized',
          apiKey === undefined
            ? `Linear rejected the access token (${op})`
            : `Linear rejected the API key (${op})`
        );
      }
      if (status === 403) {
        throw new LinearApiError('forbidden', `Linear denied access to ${op}`);
      }
      if (status >= 500) {
        if (idempotent && canRetry) {
          const waitMs = backoffMs(attempt);
          logger.warn('linear server error; retrying', {
            operation: op,
            status,
            attempt,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }
        throw new LinearApiError(
          'server',
          `Linear ${op} failed with HTTP ${status}`
        );
      }

      const data = isRecord(json) ? json['data'] : undefined;
      const hasData = isRecord(data);

      // Any error fails the request, even next to data: Linear nulls a
      // field that failed (an assignee, a project), and the mappers would
      // read that null as "none" (allocation would then overwrite a
      // person's assignment). Aliased batches recover per alias from the
      // errors' paths (runAliasedBatch), so nothing needs the partial data.
      if (errors.length > 0) {
        const kind = classifyGraphqlErrors(errors);
        const first = errors[0];
        const detail =
          first === undefined
            ? 'GraphQL error'
            : (first.userPresentableMessage ?? first.message);
        throw new LinearApiError(kind, `Linear ${op}: ${detail}`, {
          cause: new LinearGraphqlErrors(errors),
        });
      }
      if (!response.ok) {
        throw new LinearApiError(
          'graphql',
          `Linear ${op} failed with HTTP ${status}`
        );
      }
      if (!hasData) {
        throw new LinearApiError('graphql', `Linear ${op} returned no data`);
      }
      return data as T;
    }
  }

  return { request };
}
