import {
  readLinearAccount,
  TaskStore,
  writeProjectCredential,
} from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { LinearAccounts } from '../src/linear/accounts.js';
import { HttpLinearClient } from '../src/linear/client.js';
import { fakeOAuthEndpoints } from '../src/linear/oauth.js';
import {
  LinearSignIn,
  resolveLinearSignInConfig,
} from '../src/linear/signIn.js';
import { LinearOAuthFake } from './linearOAuthFake.js';
import { licensedManager } from './team/licenseKeys.js';
import { rawFetch, useTestAuth } from './testAuth.js';

const endpoints = fakeOAuthEndpoints('http://linear.fake');

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let fake: LinearOAuthFake;
let callbackPort: number;
let logs: string[];
const originalHome = process.env.DISPATCH_HOME;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

// A port nothing listens on right now, for the callback listener.
function freePort(): number {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
}

function writeConfig(dir: string, clientId: string | null): void {
  writeFileSync(
    join(dir, '.dispatch', 'config.yml'),
    `autoCommit: false\nlinear:\n  enabled: false\n${clientId === null ? '' : `  oauthClientId: ${clientId}\n`}  oauthCallbackPort: ${callbackPort}\n`
  );
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-sign-in-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_LINEAR_CLIENT_ID;
  root = mkdtempSync(join(tmpdir(), 'dispatch-linear-sign-in-'));
  TaskStore.init(root);
  callbackPort = freePort();
  fake = new LinearOAuthFake();
  fake.registerApp('client-1', [
    `http://127.0.0.1:${callbackPort}/linear/callback`,
  ]);
  writeConfig(root, 'client-1');
  writeProjectCredential(root, 'linear', { apiKey: 'lin_api_project_key' });
  // Everything the daemon prints, for the leak sweep.
  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    linearOAuth: { endpoints, fetchImpl: fake.fetch },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Every response body this test read, for the leak sweep.
const bodies: string[] = [];

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}/api/linear/${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  bodies.push(text);
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// Starts a sign-in and walks the browser through the fake's consent page to
// the callback, answering the callback page.
async function signInThroughBrowser(): Promise<Response> {
  const started = await api('POST', 'sign-in');
  expect(started.status).toBe(202);
  const back = fake.authorize(started.body.authorizeUrl as string);
  if (back === null) throw new Error('the fake refused the authorize URL');
  return rawFetch(back);
}

async function issueTeammate(tier: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/team/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${tier}@example.com`,
      displayName: tier,
      tier,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

// No OAuth token anywhere a sign-in must not reach.
function sweepForTokens(): void {
  const places = [...bodies, ...logs];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else places.push(readFileSync(path, 'utf8'));
    }
  };
  // The project's .dispatch/ (config.yml included) and Linear sync state.
  walk(join(root, '.dispatch'));
  walk(join(fakeHome, '.dispatch', 'linear'));
  for (const text of places) expect(text).not.toContain('lin_oauth_');
}

describe('the sign-in flow', () => {
  it('signs the owner in, stores the token 0600 and shows the account', async () => {
    const before = await api('GET', 'account');
    expect(before.body).toMatchObject({
      canSignIn: true,
      unavailable: null,
      callbackUrl: `http://127.0.0.1:${callbackPort}/linear/callback`,
      clientIdSource: 'config',
      pending: false,
      account: null,
      connection: {
        userId: 'u-key',
        userName: 'Key Holder',
        workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
      },
      problem: null,
    });
    const started = await api('POST', 'sign-in');
    expect(started.status).toBe(202);
    const url = new URL(started.body.authorizeUrl as string);
    expect(url.origin).toBe('http://linear.fake');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await api('GET', 'account')).body.pending).toBe(true);

    const back = fake.authorize(url.toString());
    const page = await rawFetch(back ?? '');
    const html = await page.text();
    bodies.push(html);
    expect(page.status).toBe(200);
    expect(html).toContain('Signed in to Linear as Ada Lovelace');
    expect(html).not.toContain(new URL(back ?? '').searchParams.get('code'));
    expect(html).not.toContain(url.searchParams.get('state'));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const record = readLinearAccount('org-1');
    expect(record?.user.id).toBe('u-ada');
    expect(record?.scope).toEqual(['read', 'write']);
    const credentials = join(fakeHome, '.dispatch', 'credentials.json');
    expect(statSync(credentials).mode & 0o777).toBe(0o600);

    const after = await api('GET', 'account');
    expect(after.body.pending).toBe(false);
    expect(after.body.account).toMatchObject({
      userId: 'u-ada',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      canWrite: true,
      guest: false,
      workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    });
    // The listener is gone once the flow ended.
    let refused = false;
    try {
      await rawFetch(`http://127.0.0.1:${callbackPort}/linear/callback`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(logs).toContain('dispatchd: linear: signed in as u-ada in acme');
    sweepForTokens();
  });

  it('keeps waiting through any number of wrong states, and answers 404 off the callback path', async () => {
    const started = await api('POST', 'sign-in');
    const base = `http://127.0.0.1:${callbackPort}`;
    // A page that cannot know the state must not be able to end the flow.
    for (let i = 0; i < 25; i++) {
      const wrong = await rawFetch(
        `${base}/linear/callback?error=access_denied&state=nope${i}`
      );
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain(
        'not the one Dispatch is waiting for'
      );
    }
    expect((await rawFetch(`${base}/other`)).status).toBe(404);
    // A browser's fetch or image load (not a navigation) is turned away.
    const fetched = await rawFetch(
      `${base}/linear/callback?error=access_denied&state=x`,
      { headers: { 'sec-fetch-mode': 'no-cors' } }
    );
    expect(fetched.status).toBe(404);
    expect((await api('GET', 'account')).body.pending).toBe(true);
    expect((await api('GET', 'account')).body.problem).toBeNull();
    const back = fake.authorize(started.body.authorizeUrl as string);
    expect((await rawFetch(back ?? '')).status).toBe(200);
    expect(readLinearAccount('org-1')).not.toBeNull();
  });

  it('a denial in Linear ends the flow as denied and stores nothing', async () => {
    fake.consent = { deny: true };
    const page = await signInThroughBrowser();
    const html = await page.text();
    expect(html).toContain('Sign-in was cancelled');
    expect(html).not.toContain('alert(1)');
    expect(readLinearAccount('org-1')).toBeNull();
    const view = await api('GET', 'account');
    expect(view.body.pending).toBe(false);
    expect(view.body.problem).toEqual({
      code: 'denied',
      message: 'Sign-in was cancelled in Linear. Nothing changed.',
    });
  });

  it('another workspace revokes the new grant and stores nothing', async () => {
    fake.consent = { approve: 'u-ada-other' };
    const page = await signInThroughBrowser();
    expect(page.status).toBe(409);
    expect(readLinearAccount('org-1')).toBeNull();
    expect(readLinearAccount('org-2')).toBeNull();
    expect(fake.callsTo('revoke')).toHaveLength(1);
    expect(fake.liveGrants()).toBe(0);
    const view = await api('GET', 'account');
    expect(view.body.problem).toEqual({
      code: 'wrong-workspace',
      message:
        'You signed in to Other Co, but this project syncs with Acme. Switch Linear to Acme in your browser, then sign in again.',
    });
  });

  it('asks Linear to show the workspace picker for another workspace', async () => {
    const started = await api('POST', 'sign-in', {
      body: { anotherWorkspace: true },
    });
    expect(
      new URL(started.body.authorizeUrl as string).searchParams.get('prompt')
    ).toBe('consent');
    await api('DELETE', 'sign-in');
  });

  it('a busy callback port refuses to start, with no URL', async () => {
    const squatter = Bun.serve({
      hostname: '127.0.0.1',
      port: callbackPort,
      fetch: () => new Response('mine'),
    });
    try {
      const started = await api('POST', 'sign-in');
      expect(started.status).toBe(409);
      expect(started.body.code).toBe('linear_callback_port_busy');
      expect(started.body.authorizeUrl).toBeUndefined();
    } finally {
      await squatter.stop(true);
    }
  });

  it('a second start cancels the first, whose link then fails', async () => {
    const first = await api('POST', 'sign-in');
    const second = await api('POST', 'sign-in');
    expect(second.status).toBe(202);
    const stale = fake.authorize(first.body.authorizeUrl as string);
    expect((await rawFetch(stale ?? '')).status).toBe(400);
    const fresh = fake.authorize(second.body.authorizeUrl as string);
    expect((await rawFetch(fresh ?? '')).status).toBe(200);
  });

  it('cancel closes the listener and shows no problem', async () => {
    await api('POST', 'sign-in');
    expect((await api('DELETE', 'sign-in')).status).toBe(204);
    const view = await api('GET', 'account');
    expect(view.body.pending).toBe(false);
    expect(view.body.problem).toBeNull();
  });

  it('sign-out deletes the token, revokes it, and broadcasts', async () => {
    await signInThroughBrowser();
    const out = await api('POST', 'sign-out');
    expect(out.status).toBe(200);
    expect(out.body.revoked).toBe(true);
    expect((out.body.account as Record<string, unknown>).account).toBeNull();
    expect(readLinearAccount('org-1')).toBeNull();
    expect(fake.liveGrants()).toBe(0);
    sweepForTokens();
  });
});

describe('a sign-in can always be ended', () => {
  it('after the project key stops working: the account still shows, and sign-out needs no Linear lookup', async () => {
    await signInThroughBrowser();
    expect(readLinearAccount('org-1')).not.toBeNull();
    // The key is replaced outside Settings by one Linear does not know.
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_rotated_key' });
    const view = await api('GET', 'account');
    expect(view.body.account).toMatchObject({
      userId: 'u-ada',
      workspace: { id: 'org-1' },
    });
    expect(view.body.stored).toEqual([]);
    const graphqlBefore = fake.callsTo('graphql').length;
    const out = await api('POST', 'sign-out', {
      body: { workspaceId: 'org-1' },
    });
    expect(out.status).toBe(200);
    expect(out.body.revoked).toBe(true);
    expect(readLinearAccount('org-1')).toBeNull();
    expect(fake.liveGrants()).toBe(0);
    // Deleting and revoking asked GraphQL nothing.
    expect(fake.callsTo('graphql').length - graphqlBefore).toBeLessThanOrEqual(
      1
    );
    sweepForTokens();
  });

  it('without a workspace id, signs out of the workspace it last knew', async () => {
    await signInThroughBrowser();
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_rotated_key' });
    const out = await api('POST', 'sign-out');
    expect(out.status).toBe(200);
    expect(readLinearAccount('org-1')).toBeNull();
  });

  it('a daemon that never learned the workspace lists what is stored, each with its way out', async () => {
    await signInThroughBrowser();
    await handle.stop();
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_rotated_key' });
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      linearOAuth: { endpoints, fetchImpl: fake.fetch },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const view = await api('GET', 'account');
    expect(view.body.account).toBeNull();
    expect(view.body.stored).toEqual([
      expect.objectContaining({
        userId: 'u-ada',
        workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
      }),
    ]);
    const out = await api('POST', 'sign-out', {
      body: { workspaceId: 'org-1' },
    });
    expect(out.status).toBe(200);
    expect(readLinearAccount('org-1')).toBeNull();
    expect((out.body.account as { stored: unknown[] }).stored).toEqual([]);
    sweepForTokens();
  });

  it('with the client ID removed, still shows the account and its sign-out', async () => {
    await signInThroughBrowser();
    const patched = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linear: { oauthClientId: null } }),
    });
    expect(patched.status).toBe(200);
    const view = await api('GET', 'account');
    expect(view.body.unavailable).toBe('not-configured');
    expect(view.body.canSignIn).toBe(false);
    expect(view.body.account).toMatchObject({ userId: 'u-ada' });
    const start = await api('POST', 'sign-in');
    expect(start.body.code).toBe('linear_sign_in_not_configured');
    const out = await api('POST', 'sign-out', {
      body: { workspaceId: 'org-1' },
    });
    expect(out.status).toBe(200);
    expect(readLinearAccount('org-1')).toBeNull();
  });

  it('after a disconnect, lists the stored sign-in so it can still be ended', async () => {
    await signInThroughBrowser();
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });
    const view = await api('GET', 'account');
    expect(view.body.unavailable).toBe('not-connected');
    expect(view.body.account).toBeNull();
    expect(view.body.stored).toEqual([
      expect.objectContaining({ userId: 'u-ada' }),
    ]);
    const out = await api('POST', 'sign-out', {
      body: { workspaceId: 'org-1' },
    });
    expect(out.status).toBe(200);
    expect(readLinearAccount('org-1')).toBeNull();
  });

  it('refuses a workspace id that is not a non-empty string', async () => {
    for (const workspaceId of ['', 7, null]) {
      const out = await api('POST', 'sign-out', { body: { workspaceId } });
      expect(out.status).toBe(400);
    }
  });
});

describe('the client secret', () => {
  it('is used only as the daemon was handed it, never read from the environment', async () => {
    process.env.DISPATCH_LINEAR_CLIENT_SECRET = 'from-env';
    try {
      await signInThroughBrowser();
      const exchange = fake.callsTo('token')[0];
      expect(exchange?.form.client_secret).toBeUndefined();
    } finally {
      delete process.env.DISPATCH_LINEAR_CLIENT_SECRET;
    }
    await handle.stop();
    fake.registerApp(
      'client-1',
      [`http://127.0.0.1:${callbackPort}/linear/callback`],
      'handed'
    );
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      linearOAuth: {
        endpoints,
        fetchImpl: fake.fetch,
        clientSecret: 'handed',
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    await signInThroughBrowser();
    const exchanges = fake
      .callsTo('token')
      .filter((c) => c.form.grant_type === 'authorization_code');
    expect(exchanges.at(-1)?.form.client_secret).toBe('handed');
    // The replaced grant is revoked with the secret too.
    expect(fake.callsTo('revoke').at(-1)?.form.client_secret).toBe('handed');
  });
});

describe('who may sign in', () => {
  it('refuses the agent token, and shows it no identity', async () => {
    const agent = handle.tokens.agentToken;
    for (const [method, path] of [
      ['POST', 'sign-in'],
      ['DELETE', 'sign-in'],
      ['POST', 'sign-out'],
    ] as const) {
      const res = await api(method, path, { token: agent });
      expect(res.status).toBe(403);
    }
    const view = await api('GET', 'account', { token: agent });
    expect(view.body).toMatchObject({
      canSignIn: false,
      unavailable: 'attached',
      pending: false,
      account: null,
      connection: null,
      problem: null,
    });
  });

  it('refuses a teammate at every tier, and shows them no identity', async () => {
    // Seats for three teammates beside the owner.
    handle.team.license = licensedManager(10);
    await signInThroughBrowser();
    for (const tier of ['request', 'decide', 'operator']) {
      const token = await issueTeammate(tier);
      const start = await api('POST', 'sign-in', { token });
      expect(start.status).toBe(403);
      const out = await api('POST', 'sign-out', { token });
      expect(out.status).toBe(403);
      const view = await api('GET', 'account', { token });
      expect(view.body.unavailable).toBe('teammate');
      expect(view.body.account).toBeNull();
      expect(view.body.connection).toBeNull();
    }
    expect(readLinearAccount('org-1')).not.toBeNull();
  });

  it('makes no Linear call for an unconfigured project', async () => {
    writeConfig(root, null);
    const view = await api('GET', 'account');
    expect(view.body.unavailable).toBe('not-configured');
    expect(view.body.canSignIn).toBe(false);
    const start = await api('POST', 'sign-in');
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('linear_sign_in_not_configured');
    expect(fake.calls).toHaveLength(0);
  });

  it('needs a project connection to sign in', async () => {
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });
    const view = await api('GET', 'account');
    expect(view.body.unavailable).toBe('not-connected');
    const start = await api('POST', 'sign-in');
    expect(start.body.code).toBe('linear_not_connected');
  });
});

describe('LinearSignIn', () => {
  function signIn(ttlMs: number): LinearSignIn {
    const accounts = new LinearAccounts({
      endpoints,
      fetchImpl: fake.fetch,
      log: () => undefined,
    });
    return new LinearSignIn({
      linearConfig: () => ({
        oauthClientId: 'client-1',
        oauthCallbackPort: callbackPort,
      }),
      accounts,
      connection: () =>
        new HttpLinearClient('lin_api_project_key', {
          url: endpoints.graphql,
          fetchImpl: fake.fetch,
        }).identity(),
      lastConnection: () => null,
      personClient: (auth) =>
        new HttpLinearClient(auth, {
          url: endpoints.graphql,
          fetchImpl: fake.fetch,
        }),
      endpoints,
      fetchImpl: fake.fetch,
      ttlMs,
    });
  }

  it('expires a flow nobody finished, closing the listener', async () => {
    const flow = signIn(40);
    const started = await flow.start();
    expect(started.ok).toBe(true);
    expect(flow.pending).toBe(true);
    await Bun.sleep(120);
    expect(flow.pending).toBe(false);
    expect((await flow.view('owner')).problem?.code).toBe('expired');
    let refused = false;
    try {
      await rawFetch(`http://127.0.0.1:${callbackPort}/linear/callback`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('a cancel while Linear answers revokes the grant and stores nothing', async () => {
    const flow = signIn(60_000);
    const started = await flow.start();
    if (!started.ok) throw new Error('did not start');
    let open: () => void = () => undefined;
    fake.tokenGate = new Promise((resolve) => {
      open = resolve;
    });
    const back = fake.authorize(started.authorizeUrl) ?? '';
    const answer = rawFetch(back);
    await Bun.sleep(50);
    flow.cancel();
    open();
    expect((await answer).status).toBe(409);
    expect(readLinearAccount('org-1')).toBeNull();
    expect(fake.callsTo('revoke')).toHaveLength(1);
    expect(fake.liveGrants()).toBe(0);
  });

  it('refuses a Host other than 127.0.0.1:<port>', async () => {
    const flow = signIn(60_000);
    await flow.start();
    const res = await rawFetch(
      `http://localhost:${callbackPort}/linear/callback?state=x`
    );
    expect(res.status).toBe(404);
    flow.stop();
  });
});

describe('resolveLinearSignInConfig', () => {
  it('prefers DISPATCH_LINEAR_CLIENT_ID, and reads blanks as unset', () => {
    const linear = { oauthClientId: 'from-config', oauthCallbackPort: 47823 };
    expect(
      resolveLinearSignInConfig(linear, { DISPATCH_LINEAR_CLIENT_ID: 'env-id' })
    ).toMatchObject({ clientId: 'env-id', clientIdSource: 'env' });
    expect(
      resolveLinearSignInConfig(linear, { DISPATCH_LINEAR_CLIENT_ID: ' ' })
    ).toMatchObject({ clientId: 'from-config', clientIdSource: 'config' });
    // The secret is never read here: the daemon took it at boot.
    expect(
      resolveLinearSignInConfig(null, { DISPATCH_LINEAR_CLIENT_SECRET: 's' })
    ).toEqual({
      clientId: null,
      clientIdSource: null,
      port: 47823,
      redirectUri: 'http://127.0.0.1:47823/linear/callback',
    });
  });
});
