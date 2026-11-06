import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeCode,
  isInvalidGrant,
  LINEAR_REVOKE_URL,
  LINEAR_TOKEN_URL,
  OAUTH_TIMEOUT_MS,
  OAuthError,
  parseScopes,
  refreshTokens,
  revokeToken,
} from '../../src/planner/linear/oauth.js';
import { jsonResponse, scriptedFetch } from './helpers.js';

const config = {
  clientId: 'client-123',
  clientSecret: 'secret-456',
  redirectUri: 'https://planner.example/api/auth/linear/callback',
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function form(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

async function captureOAuthError(
  promise: Promise<unknown>
): Promise<OAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OAuthError) return error;
    throw error;
  }
  throw new Error('expected an OAuthError');
}

describe('PKCE and state', () => {
  test('verifier is 43–128 base64url chars and challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(BASE64URL);
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).not.toContain('=');
    const expected = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');
    expect(challenge).toBe(expected);
  });

  test('pairs and states are random', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
    const state = createOAuthState();
    expect(state).toMatch(BASE64URL);
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(state).not.toBe(createOAuthState());
  });
});

describe('buildAuthorizeUrl', () => {
  test('user sign-in: exact params, comma-separated scopes, S256, no actor', () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        state: 'st',
        scopes: ['read'],
        codeChallenge: 'ch',
      })
    );
    expect(url.origin + url.pathname).toBe(
      'https://linear.app/oauth/authorize'
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-123',
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'read',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  test('install: read,write with actor=app and prompt=consent only when asked', () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        state: 'st',
        scopes: ['read', 'write'],
        codeChallenge: 'ch',
        actor: 'app',
        prompt: 'consent',
      })
    );
    expect(url.searchParams.get('scope')).toBe('read,write');
    expect(url.searchParams.get('actor')).toBe('app');
    expect(url.searchParams.get('prompt')).toBe('consent');

    const asUser = new URL(
      buildAuthorizeUrl(config, {
        state: 's',
        scopes: ['read', 'write'],
        codeChallenge: 'c',
        actor: 'user',
      })
    );
    expect(asUser.searchParams.has('actor')).toBe(false);
    expect(asUser.searchParams.has('prompt')).toBe(false);
  });
});

describe('token endpoint', () => {
  const tokenBody = {
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 86399,
    scope: 'read write',
    refresh_token: 'refresh-1',
  };

  test('exchangeCode posts the documented form fields and maps the response', async () => {
    const { fetch, calls } = scriptedFetch([jsonResponse(tokenBody)]);
    const before = Date.now();
    const tokens = await exchangeCode(
      config,
      { code: 'the-code', codeVerifier: 'the-verifier' },
      fetch
    );
    const after = Date.now();

    expect(calls[0]?.url).toBe(LINEAR_TOKEN_URL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(form(calls[0]?.body ?? '')).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: config.redirectUri,
      client_id: 'client-123',
      client_secret: 'secret-456',
      code_verifier: 'the-verifier',
    });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.scopes).toEqual(['read', 'write']);
    const expiresAt = Date.parse(tokens.expiresAt ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86399_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 86399_000);
  });

  test('refreshTokens posts grant_type=refresh_token with client credentials', async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse({
        ...tokenBody,
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        scope: 'read,write',
      }),
    ]);
    const tokens = await refreshTokens(config, 'refresh-1', fetch);
    expect(form(calls[0]?.body ?? '')).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-123',
      client_secret: 'secret-456',
    });
    expect(tokens).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      scopes: ['read', 'write'],
    });
  });

  test('an injected clock dates expiresAt for exchange and refresh', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(tokenBody),
      jsonResponse(tokenBody),
    ]);
    const now = (): number => Date.parse('2020-03-01T12:00:00.000Z');
    const exchanged = await exchangeCode(
      config,
      { code: 'c', codeVerifier: 'v' },
      fetch,
      { now }
    );
    expect(exchanged.expiresAt).toBe('2020-03-02T11:59:59.000Z');
    const refreshed = await refreshTokens(config, 'refresh-1', fetch, { now });
    expect(refreshed.expiresAt).toBe('2020-03-02T11:59:59.000Z');
  });

  test('missing expires_in / refresh_token become null', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse({
        access_token: 'a',
        token_type: 'Bearer',
        scope: ['read'],
      }),
    ]);
    expect(
      await exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch)
    ).toEqual({
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: ['read'],
    });
  });

  test('invalid_grant surfaces as OAuthError with that code', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'refresh token was rotated',
        },
        { status: 400 }
      ),
    ]);
    const error = await captureOAuthError(
      refreshTokens(config, 'old-refresh', fetch)
    );
    expect(error.code).toBe('invalid_grant');
    expect(error.status).toBe(400);
    expect(error.description).toBe('refresh token was rotated');
    expect(isInvalidGrant(error)).toBe(true);
    expect(error.message).not.toContain('old-refresh');
    expect(error.message).not.toContain('secret-456');
  });

  test('other failures: invalid_client, 5xx, network, junk body', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse({ error: 'invalid_client' }, { status: 401 }),
      new Response('upstream down', { status: 503 }),
      new TypeError('fetch failed'),
      jsonResponse({ token_type: 'Bearer' }),
    ]);
    expect(
      (
        await captureOAuthError(
          exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch)
        )
      ).code
    ).toBe('invalid_client');
    const server = await captureOAuthError(
      exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch)
    );
    expect(server.code).toBe('server_error');
    expect(server.status).toBe(503);
    const network = await captureOAuthError(
      exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch)
    );
    expect(network.code).toBe('network_error');
    expect(network.status).toBeNull();
    expect(
      (
        await captureOAuthError(
          exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch)
        )
      ).code
    ).toBe('invalid_response');
    expect(isInvalidGrant(server)).toBe(false);
  });
});

describe('token endpoint timeout', () => {
  // A token endpoint that never answers: the call only ends when its
  // signal aborts (refreshes run inside a row lock, so they must end).
  const stalled = (
    seen: (AbortSignal | null | undefined)[]
  ): ((url: string, init: RequestInit) => Promise<Response>) => {
    return (_url, init) => {
      seen.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason)
        );
      });
    };
  };

  test('a stalled refresh, exchange or revoke fails as network_error', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetch = stalled(seen);
    const options = { timeoutMs: 20 };
    for (const call of [
      refreshTokens(config, 'r', fetch, options),
      exchangeCode(config, { code: 'c', codeVerifier: 'v' }, fetch, options),
      revokeToken(config, 't', 'refresh_token', fetch, options),
    ]) {
      const error = await captureOAuthError(call);
      expect(error.code).toBe('network_error');
      expect(error.status).toBeNull();
    }
    expect(seen).toHaveLength(3);
  });

  test('every call carries a signal by default (OAUTH_TIMEOUT_MS)', async () => {
    expect(OAUTH_TIMEOUT_MS).toBe(15_000);
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = (_url: string, init: RequestInit): Promise<Response> => {
      signals.push(init.signal);
      return Promise.resolve(
        jsonResponse({ access_token: 'a', refresh_token: 'b', expires_in: 1 })
      );
    };
    await refreshTokens(config, 'r', fetch);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe('revokeToken', () => {
  test('posts token and token_type_hint', async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(null, { status: 200 }),
    ]);
    await revokeToken(config, 'access-1', 'access_token', fetch);
    expect(calls[0]?.url).toBe(LINEAR_REVOKE_URL);
    expect(form(calls[0]?.body ?? '')).toEqual({
      token: 'access-1',
      token_type_hint: 'access_token',
      client_id: 'client-123',
      client_secret: 'secret-456',
    });
  });

  test('an error status throws OAuthError', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse({ error: 'invalid_request' }, { status: 400 }),
    ]);
    expect(
      (
        await captureOAuthError(
          revokeToken(config, 't', 'refresh_token', fetch)
        )
      ).code
    ).toBe('invalid_request');
  });
});

describe('parseScopes', () => {
  test.each([
    ['read write', ['read', 'write']],
    ['read,write', ['read', 'write']],
    [' read , write  read ', ['read', 'write']],
    [
      ['read', 'write'],
      ['read', 'write'],
    ],
    [undefined, []],
    [42, []],
  ] as const)('%p', (input, expected) => {
    expect(parseScopes(input)).toEqual([...expected]);
  });
});
