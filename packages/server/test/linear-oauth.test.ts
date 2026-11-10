import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeCode,
  fakeOAuthEndpoints,
  isInvalidGrant,
  LINEAR_OAUTH_ENDPOINTS,
  OAuthError,
  parseScopes,
  refreshTokens,
  revokeGrant,
} from '../src/linear/oauth.js';
import { LinearOAuthFake } from './linearOAuthFake.js';

const REDIRECT = 'http://127.0.0.1:47823/linear/callback';
const endpoints = fakeOAuthEndpoints('http://linear.fake');

// A fake with the Dispatch app registered and a code issued for Ada.
function setup(secret: string | null = null) {
  const fake = new LinearOAuthFake();
  fake.registerApp('client-1', [REDIRECT], secret);
  const pkce = createPkcePair();
  const state = createOAuthState();
  const url = buildAuthorizeUrl({
    endpoints,
    clientId: 'client-1',
    redirectUri: REDIRECT,
    state,
    challenge: pkce.challenge,
  });
  const back = new URL(fake.authorize(url) ?? '');
  return {
    fake,
    pkce,
    state,
    back,
    code: back.searchParams.get('code') ?? '',
    opts: { endpoints, fetchImpl: fake.fetch },
  };
}

// The message of whatever `work` threw.
async function thrown(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (err) {
    return err as Error;
  }
  throw new Error('did not throw');
}

describe('PKCE and state', () => {
  it('makes a 43-character verifier with its S256 challenge', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash('sha256').update(verifier).digest('base64url')
    );
    expect(createPkcePair().verifier).not.toBe(verifier);
  });

  it('makes an unguessable state of 32 random bytes', () => {
    const states = new Set(Array.from({ length: 50 }, createOAuthState));
    expect(states.size).toBe(50);
    for (const s of states) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks Linear for read,write with S256 and no actor', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-1',
        redirectUri: REDIRECT,
        state: 'st',
        challenge: 'ch',
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      LINEAR_OAUTH_ENDPOINTS.authorize
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'read,write',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('adds prompt=consent only to pick another workspace', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'c',
        redirectUri: REDIRECT,
        state: 's',
        challenge: 'c',
        anotherWorkspace: true,
      })
    );
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.has('actor')).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('sends the verifier and no client secret, and answers the pair', async () => {
    const { fake, pkce, code, opts } = setup();
    const tokens = await exchangeCode(
      {
        code,
        verifier: pkce.verifier,
        clientId: 'client-1',
        redirectUri: REDIRECT,
      },
      { ...opts, now: () => Date.parse('2026-11-05T00:00:00Z') }
    );
    expect(tokens.accessToken).toStartWith('lin_oauth_access_');
    expect(tokens.refreshToken).toStartWith('lin_oauth_refresh_');
    expect(tokens.expiresAt).toBe('2026-11-05T23:59:59.000Z');
    expect(tokens.scope).toEqual(['read', 'write']);
    const [call] = fake.callsTo('token');
    expect(call?.form.code_verifier).toBe(pkce.verifier);
    expect(call?.form.grant_type).toBe('authorization_code');
    expect(call?.form.redirect_uri).toBe(REDIRECT);
    expect('client_secret' in (call?.form ?? {})).toBe(false);
  });

  it('sends the client secret only when one is set', async () => {
    const { fake, pkce, code, opts } = setup('shh');
    await exchangeCode(
      {
        code,
        verifier: pkce.verifier,
        clientId: 'client-1',
        redirectUri: REDIRECT,
        clientSecret: 'shh',
      },
      opts
    );
    expect(fake.callsTo('token')[0]?.form.client_secret).toBe('shh');
  });

  it('refuses a wrong verifier as invalid_grant, and the code is spent', async () => {
    const { pkce, code, opts } = setup();
    const err = await thrown(() =>
      exchangeCode(
        {
          code,
          verifier: createPkcePair().verifier,
          clientId: 'client-1',
          redirectUri: REDIRECT,
        },
        opts
      )
    );
    expect(isInvalidGrant(err)).toBe(true);
    // The message never carries the code or Linear's description.
    expect(err.message).not.toContain(code);
    expect(err.message).toBe(
      'Linear OAuth code exchange failed (400 invalid_grant)'
    );
    const again = await thrown(() =>
      exchangeCode(
        {
          code,
          verifier: pkce.verifier,
          clientId: 'client-1',
          redirectUri: REDIRECT,
        },
        opts
      )
    );
    expect(isInvalidGrant(again)).toBe(true);
  });

  it('falls back to the requested scopes when Linear names none', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({
          access_token: 'lin_oauth_a',
          refresh_token: 'lin_oauth_r',
          expires_in: 10,
        })
      )) as unknown as typeof fetch;
    const tokens = await exchangeCode(
      { code: 'c', verifier: 'v', clientId: 'x', redirectUri: REDIRECT },
      { endpoints, fetchImpl }
    );
    expect(tokens.scope).toEqual(['read', 'write']);
  });

  it('refuses an answer without a refresh token', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({ access_token: 'lin_oauth_a', expires_in: 10 })
      )) as unknown as typeof fetch;
    const err = await thrown(() =>
      exchangeCode(
        { code: 'c', verifier: 'v', clientId: 'x', redirectUri: REDIRECT },
        { endpoints, fetchImpl }
      )
    );
    expect((err as OAuthError).code).toBe('invalid_response');
  });

  it('times out as a network error', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      })) as unknown as typeof fetch;
    const err = await thrown(() =>
      exchangeCode(
        { code: 'c', verifier: 'v', clientId: 'x', redirectUri: REDIRECT },
        { endpoints, fetchImpl, timeoutMs: 20 }
      )
    );
    expect((err as OAuthError).code).toBe('network_error');
  });

  it('keeps a Linear error code only when it is a plain code', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json(
          { error: 'lin_oauth_leaked token here', error_description: 'x' },
          { status: 400 }
        )
      )) as unknown as typeof fetch;
    const err = await thrown(() =>
      exchangeCode(
        { code: 'c', verifier: 'v', clientId: 'x', redirectUri: REDIRECT },
        { endpoints, fetchImpl }
      )
    );
    expect((err as OAuthError).code).toBe('http_error');
    expect(err.message).not.toContain('lin_oauth_');
  });
});

describe('refreshTokens', () => {
  it('rotates the pair; the old refresh token then fails as invalid_grant', async () => {
    const { pkce, code, opts } = setup();
    const first = await exchangeCode(
      {
        code,
        verifier: pkce.verifier,
        clientId: 'client-1',
        redirectUri: REDIRECT,
      },
      opts
    );
    const second = await refreshTokens(
      { refreshToken: first.refreshToken, clientId: 'client-1' },
      opts
    );
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    const err = await thrown(() =>
      refreshTokens(
        { refreshToken: first.refreshToken, clientId: 'client-1' },
        opts
      )
    );
    expect(isInvalidGrant(err)).toBe(true);
    expect(err.message).not.toContain(first.refreshToken);
  });

  it('reports no scope when the answer leaves it out, so the caller keeps its own', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json({
          access_token: 'lin_oauth_a',
          refresh_token: 'lin_oauth_r',
          expires_in: 10,
        })
      )) as unknown as typeof fetch;
    const tokens = await refreshTokens(
      { refreshToken: 'lin_oauth_old', clientId: 'x' },
      { endpoints, fetchImpl }
    );
    expect(tokens.scope).toBeNull();
  });

  it('never follows a redirect, which would re-send the form elsewhere', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: 'https://elsewhere.example/oauth/token' },
        })
      );
    }) as unknown as typeof fetch;
    const err = await thrown(() =>
      refreshTokens(
        { refreshToken: 'lin_oauth_r', clientId: 'x', clientSecret: 's' },
        { endpoints, fetchImpl }
      )
    );
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe('manual');
    expect((err as OAuthError).code).toBe('http_error');
    expect((err as OAuthError).status).toBe(307);
    const outcome = await revokeGrant(
      {
        refreshToken: 'lin_oauth_r',
        accessToken: 'lin_oauth_a',
        clientId: 'x',
      },
      { endpoints, fetchImpl }
    );
    expect(outcome).toEqual({ revoked: false, reason: 'http_error' });
    expect(inits.every((init) => init.redirect === 'manual')).toBe(true);
  });

  it('reports a 5xx as server_error, not invalid_grant', async () => {
    const { fake, opts } = setup();
    fake.failNextToken = 500;
    const err = await thrown(() =>
      refreshTokens({ refreshToken: 'r', clientId: 'client-1' }, opts)
    );
    expect((err as OAuthError).code).toBe('server_error');
    expect(isInvalidGrant(err)).toBe(false);
  });
});

describe('revokeGrant', () => {
  async function signedIn() {
    const s = setup();
    const tokens = await exchangeCode(
      {
        code: s.code,
        verifier: s.pkce.verifier,
        clientId: 'client-1',
        redirectUri: REDIRECT,
      },
      s.opts
    );
    return { ...s, tokens };
  }

  it('revokes with the refresh token, its hint and the client id', async () => {
    const { fake, tokens, opts } = await signedIn();
    expect(
      await revokeGrant(
        {
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          clientId: 'client-1',
        },
        opts
      )
    ).toEqual({ revoked: true });
    const [call] = fake.callsTo('revoke');
    expect(call?.form).toEqual({
      token: tokens.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: 'client-1',
    });
    expect(fake.accessAlive(tokens.accessToken)).toBe(false);
  });

  it('falls back to the Bearer form when the first form is refused', async () => {
    const { fake, tokens, opts } = await signedIn();
    fake.revokeFirstForm = 401;
    expect(
      (
        await revokeGrant(
          {
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            clientId: 'client-1',
          },
          opts
        )
      ).revoked
    ).toBe(true);
    const calls = fake.callsTo('revoke');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.authorization).toBe(`Bearer ${tokens.accessToken}`);
    expect(calls[1]?.form).toEqual({});
    expect(fake.liveGrants()).toBe(0);
  });

  it('answers not revoked, with a code, when Linear cannot be reached', async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new Error('down lin_oauth_secret')
      )) as unknown as typeof fetch;
    const outcome = await revokeGrant(
      { refreshToken: 'r', accessToken: 'a', clientId: 'c' },
      { endpoints, fetchImpl }
    );
    expect(outcome).toEqual({ revoked: false, reason: 'network_error' });
  });
});

describe('parseScopes', () => {
  it('reads space, comma and list forms without duplicates', () => {
    expect(parseScopes('read write')).toEqual(['read', 'write']);
    expect(parseScopes('read,write,read')).toEqual(['read', 'write']);
    expect(parseScopes(['read', ' write '])).toEqual(['read', 'write']);
    expect(parseScopes(undefined)).toEqual([]);
  });
});
