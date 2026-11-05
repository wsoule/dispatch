// Linear OAuth 2.0 for "Sign in with Linear": the authorize URL with PKCE
// (S256), the code exchange, refresh (Linear rotates refresh tokens) and
// revocation. A desktop app cannot keep a secret, so the client is public:
// no client secret unless DISPATCH_LINEAR_CLIENT_SECRET is set. Ported from
// Better-Tracker's packages/linear/src/oauth.ts.
//
// Nothing here logs, and no error message carries a token, a code, a
// verifier, or Linear's own error text: OAuthError keeps only Linear's
// `error` code and the HTTP status.
import { createHash, randomBytes } from 'node:crypto';

/** Where the OAuth calls go. Production uses LINEAR_OAUTH_ENDPOINTS; tests and
 *  the fakes gate (DISPATCH_LINEAR_FAKE_ORIGIN) point them at a fake. */
export interface OAuthEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  /** Linear's GraphQL endpoint, for the identity check and the writes. */
  graphql: string;
}

export const LINEAR_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authorize: 'https://linear.app/oauth/authorize',
  token: 'https://api.linear.app/oauth/token',
  revoke: 'https://api.linear.app/oauth/revoke',
  graphql: 'https://api.linear.app/graphql',
};

/** The same four endpoints on a fake Linear at `origin` (tests only). */
export function fakeOAuthEndpoints(origin: string): OAuthEndpoints {
  const base = origin.replace(/\/+$/, '');
  return {
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    revoke: `${base}/oauth/revoke`,
    graphql: `${base}/graphql`,
  };
}

/** Longest wait for one OAuth endpoint call: a refresh holds a cross-process
 *  lock, so a stalled endpoint must not hold it for long. */
const OAUTH_TIMEOUT_MS = 15_000;

/** What Dispatch asks for: read, and write for issues and comments. Never
 *  `admin`, and never `actor=app`, so writes are credited to the person. */
const LINEAR_OAUTH_SCOPES: readonly string[] = ['read', 'write'];

// Linear's access tokens last about a day; used when a response omits it.
const DEFAULT_EXPIRES_IN_SEC = 86_399;

/**
 * A failed OAuth call. `code` is Linear's OAuth `error` value when it sent a
 * plain one (`invalid_grant`, `invalid_client`, …), else `server_error` (a
 * 5xx or an unexpected status), `network_error` (no answer, or a timeout) or
 * `invalid_response` (the body was not a token response). The message is
 * built from the action, the status and the code only.
 */
export class OAuthError extends Error {
  readonly code: string;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;

  constructor(code: string, action: string, status: number | null = null) {
    super(`Linear OAuth ${action} failed (${status ?? 'no response'} ${code})`);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/** True for the error that means the grant (a code or refresh token) is dead. */
export function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === 'invalid_grant';
}

/** A PKCE pair: a 43-character base64url verifier from 32 random bytes and
 *  its S256 challenge (base64url of the verifier's SHA-256). */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** An unguessable `state` for the authorize round trip: 32 random bytes. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** The consent page URL. Scopes are comma separated, as Linear expects;
 *  `prompt=consent` only when the person asks to pick another workspace. */
export function buildAuthorizeUrl(input: {
  endpoints?: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  anotherWorkspace?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: LINEAR_OAUTH_SCOPES.join(','),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  });
  if (input.anotherWorkspace === true) params.set('prompt', 'consent');
  const endpoints = input.endpoints ?? LINEAR_OAUTH_ENDPOINTS;
  return `${endpoints.authorize}?${params.toString()}`;
}

/** Splits a `scope` Linear sends as "read write", "read,write" or a list. */
export function parseScopes(value: unknown): string[] {
  const parts: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const scopes: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const scope = part.trim();
    if (scope !== '' && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/** A token endpoint's answer. `refreshToken` is null when Linear sent none. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token expires. */
  expiresAt: string;
  /** What Linear granted; null when the answer did not say. */
  scope: string[] | null;
}

/** How the OAuth calls are made; every field has a production default. */
export interface OAuthCallOptions {
  endpoints?: OAuthEndpoints;
  fetchImpl?: typeof fetch;
  /** Epoch ms that `expires_in` counts from. */
  now?: () => number;
  timeoutMs?: number;
}

// An OAuth `error` value kept only when it is a plain code, so nothing
// Linear sends back can be smuggled into a message.
function errorCode(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const code = (body as Record<string, unknown>).error;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)
    ? code
    : fallback;
}

// POSTs a form to a Linear OAuth endpoint and answers its JSON body. A
// failure to answer, a timeout, or an error status becomes an OAuthError.
async function postForm(
  url: string,
  form: Record<string, string>,
  action: string,
  opts: OAuthCallOptions,
  headers: Record<string, string> = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? OAUTH_TIMEOUT_MS),
      // A redirect would re-send the form (a code and verifier, a refresh
      // token, a secret) to wherever it points: it is answered as an error.
      redirect: 'manual',
    });
  } catch {
    throw new OAuthError('network_error', action);
  }
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const fallback = response.status >= 500 ? 'server_error' : 'http_error';
    throw new OAuthError(errorCode(body, fallback), action, response.status);
  }
  return body;
}

// Narrows a token response (access_token, token_type, expires_in, scope,
// refresh_token) to a TokenSet.
function toTokenSet(body: unknown, action: string, now: number): TokenSet {
  if (typeof body !== 'object' || body === null)
    throw new OAuthError('invalid_response', action);
  const b = body as Record<string, unknown>;
  if (b.error !== undefined)
    throw new OAuthError(errorCode(b, 'server_error'), action);
  if (typeof b.access_token !== 'string' || b.access_token === '')
    throw new OAuthError('invalid_response', action);
  const expiresIn =
    typeof b.expires_in === 'number' && Number.isFinite(b.expires_in)
      ? b.expires_in
      : DEFAULT_EXPIRES_IN_SEC;
  const scope = parseScopes(b.scope);
  return {
    accessToken: b.access_token,
    refreshToken:
      typeof b.refresh_token === 'string' && b.refresh_token !== ''
        ? b.refresh_token
        : null,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    scope: scope.length === 0 ? null : scope,
  };
}

// The client's own fields of a token-endpoint form: the secret only when one
// is configured, since the public client proves itself with PKCE instead.
function clientFields(
  clientId: string,
  clientSecret: string | undefined
): Record<string, string> {
  return clientSecret === undefined || clientSecret === ''
    ? { client_id: clientId }
    : { client_id: clientId, client_secret: clientSecret };
}

/** Exchanges an authorization code and its PKCE verifier for a token pair. A
 *  response without a refresh token is refused: the grant could not last.
 *  A response that names no scope granted what was asked for. */
export async function exchangeCode(
  input: {
    code: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
    clientSecret?: string;
  },
  opts: OAuthCallOptions = {}
): Promise<TokenSet & { refreshToken: string; scope: string[] }> {
  const endpoints = opts.endpoints ?? LINEAR_OAUTH_ENDPOINTS;
  const body = await postForm(
    endpoints.token,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      ...clientFields(input.clientId, input.clientSecret),
      code_verifier: input.verifier,
    },
    'code exchange',
    opts
  );
  const tokens = toTokenSet(body, 'code exchange', (opts.now ?? Date.now)());
  if (tokens.refreshToken === null)
    throw new OAuthError('invalid_response', 'code exchange');
  return {
    ...tokens,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope ?? [...LINEAR_OAUTH_SCOPES],
  };
}

/** Refreshes an access token. Linear rotates the refresh token: the answer
 *  replaces the old pair, which stops working, so callers store it first.
 *  `scope` is null when Linear left it out: the grant's scope is unchanged,
 *  and the caller keeps what it stored. */
export async function refreshTokens(
  input: { refreshToken: string; clientId: string; clientSecret?: string },
  opts: OAuthCallOptions = {}
): Promise<TokenSet> {
  const endpoints = opts.endpoints ?? LINEAR_OAUTH_ENDPOINTS;
  const body = await postForm(
    endpoints.token,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      ...clientFields(input.clientId, input.clientSecret),
    },
    'refresh',
    opts
  );
  return toTokenSet(body, 'refresh', (opts.now ?? Date.now)());
}

/** Whether a revoke landed, and a fixed reason code when it did not. */
export type RevokeOutcome =
  | { revoked: true }
  | { revoked: false; reason: string };

/**
 * Ends a grant at Linear: the refresh token with its hint and the client id
 * (RFC 7009). Linear's own demo revokes with the access token as a Bearer
 * header instead, so a 400 or 401 to the first form falls back to that one.
 * Never throws; revoking ends both tokens.
 */
export async function revokeGrant(
  input: {
    refreshToken: string;
    accessToken: string;
    clientId: string;
    clientSecret?: string;
  },
  opts: OAuthCallOptions = {}
): Promise<RevokeOutcome> {
  const endpoints = opts.endpoints ?? LINEAR_OAUTH_ENDPOINTS;
  try {
    await postForm(
      endpoints.revoke,
      {
        token: input.refreshToken,
        token_type_hint: 'refresh_token',
        ...clientFields(input.clientId, input.clientSecret),
      },
      'revoke',
      opts
    );
    return { revoked: true };
  } catch (err) {
    const status = err instanceof OAuthError ? err.status : null;
    if (status !== 400 && status !== 401)
      return { revoked: false, reason: (err as OAuthError).code };
  }
  try {
    await postForm(endpoints.revoke, {}, 'revoke', opts, {
      authorization: `Bearer ${input.accessToken}`,
    });
    return { revoked: true };
  } catch (err) {
    return {
      revoked: false,
      reason: err instanceof OAuthError ? err.code : 'network_error',
    };
  }
}
