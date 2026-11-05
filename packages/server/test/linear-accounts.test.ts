import {
  readLinearAccount,
  removeLinearAccount,
  writeLinearAccount,
} from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LINEAR_SIGN_IN_ENDED_MESSAGE,
  LINEAR_SIGNED_OUT_MESSAGE,
  LinearAccounts,
  REFRESH_MARGIN_MS,
} from '../src/linear/accounts.js';
import { HttpLinearClient } from '../src/linear/client.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  fakeOAuthEndpoints,
} from '../src/linear/oauth.js';
import { LinearOAuthFake } from './linearOAuthFake.js';

const REDIRECT = 'http://127.0.0.1:47823/linear/callback';
const endpoints = fakeOAuthEndpoints('http://linear.fake');

let fakeHome: string;
let fake: LinearOAuthFake;
let changes: number;
let logs: string[];
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-accounts-'));
  process.env.DISPATCH_HOME = fakeHome;
  fake = new LinearOAuthFake();
  fake.registerApp('client-1', [REDIRECT]);
  changes = 0;
  logs = [];
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

function accounts(now: () => number = Date.now): LinearAccounts {
  return new LinearAccounts({
    endpoints,
    fetchImpl: fake.fetch,
    now,
    onChange: () => {
      changes += 1;
    },
    log: (line) => logs.push(line),
  });
}

// Signs Ada in at the fake and stores the record, expiring at `expiresAt`.
async function signedIn(
  expiresAt = new Date(Date.now() + 3_600_000).toISOString()
): Promise<LinearAccountRecord> {
  const pkce = createPkcePair();
  const back = new URL(
    fake.authorize(
      buildAuthorizeUrl({
        endpoints,
        clientId: 'client-1',
        redirectUri: REDIRECT,
        state: 's',
        challenge: pkce.challenge,
      })
    ) ?? ''
  );
  const tokens = await exchangeCode(
    {
      code: back.searchParams.get('code') ?? '',
      verifier: pkce.verifier,
      clientId: 'client-1',
      redirectUri: REDIRECT,
    },
    { endpoints, fetchImpl: fake.fetch }
  );
  const record: LinearAccountRecord = {
    version: 1,
    clientId: 'client-1',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt,
    scope: tokens.scope,
    user: {
      id: 'u-ada',
      name: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      guest: false,
      admin: false,
    },
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    signedInAt: new Date().toISOString(),
    refreshedAt: null,
  };
  await writeLinearAccount(record);
  return record;
}

describe('LinearAccounts.access', () => {
  it('answers the stored token while it is not due, without calling Linear', async () => {
    const record = await signedIn();
    const access = await accounts().access('org-1');
    expect(access).toEqual({ ok: true, token: record.accessToken });
    expect(fake.callsTo('token')).toHaveLength(1);
  });

  it('refreshes from five minutes before expiry and stores the new pair first', async () => {
    const record = await signedIn(
      new Date(Date.now() + REFRESH_MARGIN_MS - 1000).toISOString()
    );
    const access = await accounts().access('org-1');
    expect(access.ok).toBe(true);
    const stored = readLinearAccount('org-1');
    if (!access.ok) throw new Error('no token');
    expect(access.token).toBe(stored?.accessToken ?? '');
    expect(stored?.accessToken).not.toBe(record.accessToken);
    expect(stored?.refreshToken).not.toBe(record.refreshToken);
    expect(stored?.refreshedAt).not.toBeNull();
    const refresh = fake.callsTo('token')[1];
    expect(refresh?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: record.refreshToken,
      client_id: 'client-1',
    });
  });

  it('refreshes once for two concurrent callers', async () => {
    await signedIn(new Date(Date.now() - 1000).toISOString());
    const a = accounts();
    const b = accounts();
    const [one, two] = await Promise.all([
      a.access('org-1'),
      b.access('org-1'),
    ]);
    expect(one).toEqual(two);
    expect(fake.callsTo('token')).toHaveLength(2);
  });

  it('a forced refresh after another process refreshed answers the stored token', async () => {
    const record = await signedIn();
    const first = await accounts().access('org-1', {
      force: true,
      failedToken: record.accessToken,
    });
    if (!first.ok) throw new Error('no token');
    // A second process that still holds the old token asks too.
    const second = await accounts().access('org-1', {
      force: true,
      failedToken: record.accessToken,
    });
    expect(second).toEqual({ ok: true, token: first.token });
    expect(fake.callsTo('token')).toHaveLength(2);
  });

  it('invalid_grant deletes the record, marks it ended and says so once', async () => {
    await signedIn(new Date(Date.now() - 1000).toISOString());
    fake.revokeAll();
    const service = accounts();
    expect(await service.access('org-1')).toEqual({
      ok: false,
      signedOut: true,
      message: LINEAR_SIGN_IN_ENDED_MESSAGE,
    });
    expect(readLinearAccount('org-1')).toBeNull();
    expect(service.endedFor('org-1')).toBe(LINEAR_SIGN_IN_ENDED_MESSAGE);
    expect(changes).toBe(1);
    expect(logs).toEqual(['linear: Linear ended the sign-in in acme']);
    // A dead grant needs no revoke.
    expect(fake.callsTo('revoke')).toHaveLength(0);
  });

  it('a network failure keeps the record', async () => {
    const record = await signedIn(new Date(Date.now() - 1000).toISOString());
    fake.failNextToken = 'network';
    expect(await accounts().access('org-1')).toEqual({
      ok: false,
      signedOut: false,
      message: 'could not refresh your Linear sign-in: Linear did not answer',
    });
    expect(readLinearAccount('org-1')?.refreshToken).toBe(record.refreshToken);
  });

  it('a 5xx keeps the record and says Linear answered with an error', async () => {
    const record = await signedIn(new Date(Date.now() - 1000).toISOString());
    fake.failNextToken = 500;
    expect(await accounts().access('org-1')).toEqual({
      ok: false,
      signedOut: false,
      message:
        'could not refresh your Linear sign-in: Linear answered with an error',
    });
    expect(readLinearAccount('org-1')?.refreshToken).toBe(record.refreshToken);
  });

  it('a failed early refresh keeps using a token that has not expired', async () => {
    const record = await signedIn(new Date(Date.now() + 60_000).toISOString());
    fake.failNextToken = 'network';
    const service = accounts();
    expect(await service.access('org-1')).toEqual({
      ok: true,
      token: record.accessToken,
    });
    // The next request tries the refresh again, and it lands.
    const again = await service.access('org-1');
    expect(again.ok).toBe(true);
    expect(readLinearAccount('org-1')?.accessToken).not.toBe(
      record.accessToken
    );
    expect(fake.callsTo('token')).toHaveLength(3);
  });

  for (const [what, answer] of [
    ['invalid_client', { status: 401, body: { error: 'invalid_client' } }],
    ['a bare 400', { status: 400, body: {} }],
  ] as const) {
    it(`a refresh Linear refuses with ${what} signs out, names it, and revokes`, async () => {
      const record = await signedIn(new Date(Date.now() - 1000).toISOString());
      fake.answerNextToken = answer;
      const service = accounts();
      const code = what === 'a bare 400' ? 'http_error' : 'invalid_client';
      const message = `Linear refused to renew your sign-in (${code}). Sign in again; until then your changes go through the project connection.`;
      expect(await service.access('org-1')).toEqual({
        ok: false,
        signedOut: true,
        message,
      });
      expect(readLinearAccount('org-1')).toBeNull();
      expect(service.endedFor('org-1')).toBe(message);
      expect(changes).toBe(1);
      expect(logs).toEqual([
        'linear: Linear refused to renew the sign-in in acme',
      ]);
      // The refused grant may still be alive at Linear: it is revoked.
      expect(fake.callsTo('revoke')[0]?.form.token).toBe(record.refreshToken);
      // Signed out, no request reaches the token endpoint again.
      const before = fake.callsTo('token').length;
      expect((await service.access('org-1')).ok).toBe(false);
      expect(fake.callsTo('token')).toHaveLength(before);
    });
  }

  it('keeps the granted scope when a refresh answer leaves it out', async () => {
    const record = await signedIn(new Date(Date.now() - 1000).toISOString());
    await writeLinearAccount({ ...record, scope: ['read'] });
    fake.omitScopeOnRefresh = true;
    const access = await accounts().access('org-1');
    expect(access.ok).toBe(true);
    const stored = readLinearAccount('org-1');
    expect(stored?.accessToken).not.toBe(record.accessToken);
    expect(stored?.scope).toEqual(['read']);
  });

  it('revokes, with the client secret, a refreshed pair it could not store', async () => {
    await signedIn(new Date(Date.now() - 1000).toISOString());
    fake.registerApp('client-1', [REDIRECT], 'shh');
    let open: () => void = () => undefined;
    fake.tokenGate = new Promise((resolve) => {
      open = resolve;
    });
    const service = new LinearAccounts({
      endpoints,
      fetchImpl: fake.fetch,
      clientSecret: 'shh',
      log: () => undefined,
    });
    const refreshing = service.access('org-1');
    await Bun.sleep(30);
    // Signed out elsewhere while Linear answered (no lock: a stale writer).
    await removeLinearAccount('org-1');
    open();
    fake.tokenGate = null;
    expect(await refreshing).toEqual({
      ok: false,
      signedOut: true,
      message: LINEAR_SIGNED_OUT_MESSAGE,
    });
    const revoke = fake.callsTo('revoke')[0];
    expect(revoke?.form.client_secret).toBe('shh');
    expect(fake.liveGrants()).toBe(0);
  });

  it('a lost refresh response is answered again within the replay grace', async () => {
    const record = await signedIn(new Date(Date.now() - 1000).toISOString());
    fake.replayGraceMs = 60_000;
    // Another process refreshed, but its answer never got stored.
    const lost = await fake.fetch(endpoints.token, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: 'client-1',
      }).toString(),
    });
    const lostBody = (await lost.json()) as { access_token: string };
    const access = await accounts().access('org-1');
    expect(access).toEqual({ ok: true, token: lostBody.access_token });
  });

  it('signed out when nothing is stored', async () => {
    expect(await accounts().access('org-1')).toEqual({
      ok: false,
      signedOut: true,
      message: LINEAR_SIGNED_OUT_MESSAGE,
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('LinearAccounts.authFor', () => {
  it('drives a person client: Bearer, a 401, one refresh, one retry', async () => {
    const record = await signedIn();
    fake.killAccess(record.accessToken);
    const client = new HttpLinearClient(accounts().authFor('org-1'), {
      url: endpoints.graphql,
      fetchImpl: fake.fetch,
    });
    const identity = await client.identity();
    expect(identity.ok).toBe(true);
    const graphql = fake.callsTo('graphql');
    expect(graphql).toHaveLength(2);
    expect(graphql[0]?.authorization).toBe(`Bearer ${record.accessToken}`);
    expect(graphql[1]?.authorization).toBe(
      `Bearer ${readLinearAccount('org-1')?.accessToken ?? ''}`
    );
  });

  it('fails a signed-out request as auth, saying so', async () => {
    const client = new HttpLinearClient(accounts().authFor('org-1'), {
      url: endpoints.graphql,
      fetchImpl: fake.fetch,
    });
    const result = await client.viewer();
    expect(result).toEqual({
      ok: false,
      kind: 'auth',
      error: LINEAR_SIGNED_OUT_MESSAGE,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('a 403 refusal does not refresh or resend: only an unaccepted token does', async () => {
    const record = await signedIn();
    let graphql = 0;
    const forbidden = (async (url: string, init?: RequestInit) => {
      if (url === endpoints.graphql) {
        graphql += 1;
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Forbidden: guests cannot act in this team' }],
          }),
          { status: 403 }
        );
      }
      return fake.fetch(url, init);
    }) as typeof fetch;
    const client = new HttpLinearClient(accounts().authFor('org-1'), {
      url: endpoints.graphql,
      fetchImpl: forbidden,
    });
    for (let i = 0; i < 3; i++) {
      const result = await client.updateIssue('i1', { title: 't' });
      expect(result.ok).toBe(false);
    }
    expect(graphql).toBe(3);
    // Only the sign-in's own exchange reached the token endpoint.
    expect(fake.callsTo('token')).toHaveLength(1);
    expect(readLinearAccount('org-1')?.accessToken).toBe(record.accessToken);
  });
});

describe('LinearAccounts.signOut and save', () => {
  it('deletes the record, then revokes it', async () => {
    const record = await signedIn();
    const out = await accounts().signOut('org-1');
    expect(out).toEqual({ signedOut: true, revoked: true });
    expect(readLinearAccount('org-1')).toBeNull();
    expect(fake.callsTo('revoke')[0]?.form.token).toBe(record.refreshToken);
    expect(fake.liveGrants()).toBe(0);
    expect(logs.at(-1)).toBe('linear: signed out of acme (revoked)');
    expect(logs.join('\n')).not.toContain('lin_oauth_');
  });

  it('still deletes the record when Linear cannot be reached to revoke', async () => {
    await signedIn();
    const down = new LinearAccounts({
      endpoints,
      fetchImpl: (() =>
        Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      log: (line) => logs.push(line),
    });
    expect(await down.signOut('org-1')).toEqual({
      signedOut: true,
      revoked: false,
    });
    expect(readLinearAccount('org-1')).toBeNull();
    expect(logs.at(-1)).toBe(
      'linear: signed out of acme (not revoked: network_error)'
    );
  });

  it('a refresh racing a sign-out does not bring the record back', async () => {
    const record = await signedIn(new Date(Date.now() - 1000).toISOString());
    let open: () => void = () => undefined;
    fake.tokenGate = new Promise((resolve) => {
      open = resolve;
    });
    const service = accounts();
    const refreshing = service.access('org-1');
    await Bun.sleep(30);
    const signingOut = service.signOut('org-1');
    await Bun.sleep(30);
    open();
    fake.tokenGate = null;
    const [access] = await Promise.all([refreshing, signingOut]);
    // The refresh finished first (it held the lock), then sign-out deleted.
    expect(access.ok).toBe(true);
    expect(readLinearAccount('org-1')).toBeNull();
    expect(fake.liveGrants()).toBe(0);
    expect(record.refreshToken).not.toBe('');
  });

  it('a new sign-in for the same workspace revokes the grant it replaced', async () => {
    const first = await signedIn();
    const second = await signedIn();
    await writeLinearAccount(first);
    await accounts().save(second);
    expect(readLinearAccount('org-1')?.refreshToken).toBe(second.refreshToken);
    expect(fake.callsTo('revoke').map((c) => c.form.token)).toEqual([
      first.refreshToken,
    ]);
    expect(fake.liveGrants()).toBe(1);
  });
});
