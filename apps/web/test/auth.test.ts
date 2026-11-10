import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { TeamDb } from '../src/db.js';
import { Sealer } from '../src/linear.js';
import { LinearGrants } from '../src/planner/grants.js';
import { webHandler } from '../src/web.js';

// Sign-in with Linear (PKCE on the public "Dispatch" app) and linking GitHub
// and Linear into one account, against fake Linear and GitHub endpoints.

const ORIGIN = 'http://team.test';
let db: TeamDb;
let handle: (req: Request) => Promise<Response | null>;
let viewer: { id: string; name: string; displayName: string };
let ghUser: { id: number; login: string };
let grants: LinearGrants;
const ORG = { id: 'org-1', name: 'Acme', urlKey: 'acme' };
const seen: { url: string; body: string; auth: string | null }[] = [];
const installs: { userId: string; record: LinearAccountRecord }[] = [];

const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : input.toString();
  const body = typeof init?.body === 'string' ? init.body : '';
  const auth = new Headers(init?.headers).get('authorization');
  seen.push({ url, body, auth });
  if (url === 'https://api.linear.app/oauth/token')
    return Promise.resolve(
      Response.json({
        access_token: 'lin-token',
        token_type: 'Bearer',
        refresh_token: 'lin-refresh',
        expires_in: 86_399,
      })
    );
  if (url === 'https://api.linear.app/graphql')
    return Promise.resolve(
      Response.json({ data: { viewer, organization: ORG } })
    );
  if (url === 'https://api.linear.app/oauth/revoke')
    return Promise.resolve(new Response(null, { status: 200 }));
  if (url === 'https://github.com/login/oauth/access_token')
    return Promise.resolve(Response.json({ access_token: 'gh-token' }));
  if (url === 'https://api.github.com/user')
    return Promise.resolve(Response.json({ ...ghUser, name: null }));
  return Promise.resolve(new Response('unexpected', { status: 500 }));
}) as typeof fetch;

function setup(linearClientId: string | null): void {
  db = new TeamDb(':memory:');
  grants = new LinearGrants(
    db.db,
    new Sealer('secret'),
    'lin-client',
    fakeFetch
  );
  handle = webHandler({
    grants,
    install: (userId, record) => {
      installs.push({ userId, record });
      return Promise.resolve();
    },
    db,
    config: {
      origin: ORIGIN,
      githubClientId: 'gh-client',
      githubClientSecret: 'gh-secret',
      linearClientId,
      devLogin: false,
    },
    sessions: () => [],
    fetch: fakeFetch,
  });
}

beforeEach(() => {
  seen.length = 0;
  installs.length = 0;
  viewer = { id: 'lin-grace', name: 'Grace Hopper', displayName: 'grace' };
  ghUser = { id: 42, login: 'grace-gh' };
  setup('lin-client');
});
afterEach(() => db.close());

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await handle(new Request(`${ORIGIN}${path}`, init));
  if (res === null) throw new Error(`no route ${path}`);
  return res;
}

function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') ?? '';
  return set.slice(0, set.indexOf(';'));
}

// Runs an OAuth round trip from its start response: follows the provider
// redirect's state back to our callback with the flow's cookie.
async function complete(
  start: Response,
  provider: 'linear' | 'github',
  session = ''
): Promise<Response> {
  const target = new URL(start.headers.get('location') ?? '');
  const state = target.searchParams.get('state') ?? '';
  const cookie = [cookieOf(start), session].filter((c) => c !== '').join('; ');
  return call(`/auth/${provider}/callback?code=the-code&state=${state}`, {
    headers: { cookie },
  });
}

async function me(session: string): Promise<string> {
  const page = await (await call('/', { headers: { cookie: session } })).text();
  return page;
}

describe('Linear sign-in', () => {
  it('sends the person to Linear with a PKCE challenge and an identity-only scope', async () => {
    const start = await call('/auth/linear?next=/teams');
    expect(start.status).toBe(303);
    const target = new URL(start.headers.get('location') ?? '');
    expect(target.origin + target.pathname).toBe(
      'https://linear.app/oauth/authorize'
    );
    expect(target.searchParams.get('client_id')).toBe('lin-client');
    expect(target.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/auth/linear/callback`
    );
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('scope')).toBe('read');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    );
  });

  it('signs in, creating the account once, and proves the PKCE verifier', async () => {
    const start = await call('/auth/linear?next=/teams');
    const challenge = new URL(
      start.headers.get('location') ?? ''
    ).searchParams.get('code_challenge');
    const done = await complete(start, 'linear');
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/teams');
    const session = cookieOf(done);
    expect(session.startsWith('dt_session=')).toBe(true);

    const token = seen.find(
      (s) => s.url === 'https://api.linear.app/oauth/token'
    );
    const form = new URLSearchParams(token?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe('lin-client');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/auth/linear/callback`);
    const verifier = form.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      challenge ?? ''
    );
    expect(
      seen.find((s) => s.url === 'https://api.linear.app/graphql')?.auth
    ).toBe('Bearer lin-token');
    // The token only proved who this is: it is revoked, not kept.
    expect(
      seen.some((s) => s.url === 'https://api.linear.app/oauth/revoke')
    ).toBe(true);

    expect(await me(session)).toContain('grace');
    const again = await complete(await call('/auth/linear'), 'linear');
    expect(
      db.webSessionUser(cookieOf(again).slice('dt_session='.length))?.id
    ).toBe(db.webSessionUser(session.slice('dt_session='.length))?.id);
  });

  it('refuses a callback whose state does not match its cookie', async () => {
    const start = await call('/auth/linear');
    const res = await call('/auth/linear/callback?code=x&state=forged', {
      headers: { cookie: cookieOf(start) },
    });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('answers 503 and hides the button when no Linear app is configured', async () => {
    db.close();
    setup(null);
    expect((await call('/auth/linear')).status).toBe(503);
    expect(await (await call('/')).text()).not.toContain('Sign in with Linear');
    db.close();
    setup('lin-client');
    expect(await (await call('/')).text()).toContain('Sign in with Linear');
  });
});

describe('linking accounts', () => {
  async function githubSession(): Promise<string> {
    return cookieOf(await complete(await call('/auth/github'), 'github'));
  }
  const post = (path: string, cookie: string, origin = ORIGIN) =>
    call(path, { method: 'POST', headers: { cookie, origin } });

  it('connects Linear to a GitHub account, so either signs in to it', async () => {
    const session = await githubSession();
    expect(await me(session)).toContain('Connect Linear');
    const linked = await complete(
      await post('/auth/linear/link', session),
      'linear',
      session
    );
    expect(linked.status).toBe(303);
    expect(linked.headers.get('location')).toBe('/');
    expect(await me(session)).not.toContain('Connect Linear');

    const viaLinear = cookieOf(
      await complete(await call('/auth/linear'), 'linear')
    );
    expect(
      db.webSessionUser(viaLinear.slice('dt_session='.length))?.login
    ).toBe('grace-gh');
  });

  it('connects GitHub to a Linear account', async () => {
    const session = cookieOf(
      await complete(await call('/auth/linear'), 'linear')
    );
    await complete(await post('/auth/github/link', session), 'github', session);
    const viaGithub = await githubSession();
    expect(
      db.webSessionUser(viaGithub.slice('dt_session='.length))?.login
    ).toBe('grace');
  });

  it('refuses to link a Linear user that already has its own account', async () => {
    await complete(await call('/auth/linear'), 'linear');
    const session = await githubSession();
    const res = await complete(
      await post('/auth/linear/link', session),
      'linear',
      session
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('grace');
    expect(await me(session)).toContain('Connect Linear');
  });

  it('only links from a signed-in form on this site', async () => {
    const session = await githubSession();
    expect(
      (await post('/auth/linear/link', session, 'https://evil.test')).status
    ).toBe(403);
    expect((await post('/auth/linear/link', '')).headers.get('location')).toBe(
      '/'
    );
    // A link flow finished after signing out signs no one in and links nothing.
    const start = await post('/auth/linear/link', session);
    const res = await complete(start, 'linear');
    expect(res.status).toBe(401);
    expect(
      db.identities(db.webSessionUser(session.slice('dt_session='.length))!.id)
        .linear
    ).toBe(false);
  });
});

describe('opening a Linear workspace', () => {
  it('signs a newcomer in with Linear and keeps a sealed read grant', async () => {
    const start = await call('/auth/linear/workspace');
    const target = new URL(start.headers.get('location') ?? '');
    // Read and write: the person's edits go back to Linear as them.
    expect(target.searchParams.get('scope')).toBe('read,write');
    expect(target.searchParams.get('actor')).toBeNull();
    const done = await complete(start, 'linear');
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/w/acme/');
    const session = cookieOf(done);
    const user = db.webSessionUser(session.slice('dt_session='.length));
    expect(user?.login).toBe('grace');
    expect(grants.member(user!.id, 'org-1')).toEqual({
      linearUserId: 'lin-grace',
    });
    expect(await grants.accessToken(user!.id, 'org-1')).toBe('lin-token');
    // This token is the grant: it is kept, not revoked.
    expect(
      seen.some((x) => x.url === 'https://api.linear.app/oauth/revoke')
    ).toBe(false);
  });

  it('adds the grant to the account already signed in', async () => {
    const session = cookieOf(
      await complete(await call('/auth/github'), 'github')
    );
    const done = await complete(
      await call('/auth/linear/workspace'),
      'linear',
      session
    );
    expect(done.headers.get('location')).toBe('/w/acme/');
    const ada = db.webSessionUser(session.slice('dt_session='.length))!;
    expect(ada.login).toBe('grace-gh');
    expect(grants.member(ada.id, 'org-1')).toEqual({
      linearUserId: 'lin-grace',
    });
    // Its Linear identity was free, so it joins the account too.
    expect(db.identities(ada.id)).toEqual({ github: true, linear: true });
  });

  it('lists your workspaces on the home page, and the demo only without one', async () => {
    const fresh = cookieOf(
      await complete(await call('/auth/github'), 'github')
    );
    const empty = await (
      await call('/', { headers: { cookie: fresh } })
    ).text();
    expect(empty).toContain('href="/w/demo/"');
    expect(empty).toContain('Open a workspace');

    const session = cookieOf(
      await complete(await call('/auth/linear/workspace'), 'linear')
    );
    const home = await (
      await call('/?all=1', { headers: { cookie: session } })
    ).text();
    expect(home).toContain('href="/w/acme/"');
    expect(home).toContain('Linear workspace');
    expect(home).not.toContain('href="/w/demo/"');
    // One way in, not two near-identical buttons.
    expect(home.match(/href="\/auth\/linear\/workspace"/g)).toHaveLength(1);
    expect(home).toContain('Add a workspace');
  });

  it('folds the account page into Home', async () => {
    const session = cookieOf(
      await complete(await call('/auth/linear/workspace'), 'linear')
    );
    const res = await call('/account', { headers: { cookie: session } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const home = await (
      await call('/', { headers: { cookie: session } })
    ).text();
    expect(home).toContain('Signed in with Linear');
    expect(home).toContain('Connect GitHub');
    expect(home).not.toContain('href="/account"');
  });

  it('lands someone in one team on home, not that team’s page', async () => {
    const session = cookieOf(
      await complete(await call('/auth/linear/workspace'), 'linear')
    );
    const user = db.webSessionUser(session.slice('dt_session='.length))!;
    const team = db.createTeam('Core', user.id);
    const res = await call('/', { headers: { cookie: session } });
    expect(res.status).toBe(200);
    const home = await res.text();
    expect(home).toContain('href="/w/acme/"');
    expect(home).toContain('id="machines"');
    expect(home).toContain(`href="/teams/${team.id}"`);
    expect(home).toContain('Team · admin');
  });
});

describe('installing Dispatch on a workspace', () => {
  it('asks a signed-out visitor to sign in first', async () => {
    const res = await call('/auth/linear/install');
    expect(res.headers.get('location')).toBe(
      `/auth/linear?next=${encodeURIComponent('/auth/linear/install')}`
    );
  });

  it('installs as the app, then opens the workspace as the installer', async () => {
    const session = cookieOf(
      await complete(await call('/auth/github'), 'github')
    );
    const start = await call('/auth/linear/install', {
      headers: { cookie: session },
    });
    const target = new URL(start.headers.get('location') ?? '');
    expect(target.searchParams.get('actor')).toBe('app');
    // An app user needs its own scope to read initiatives.
    expect(target.searchParams.get('scope')).toBe('read,write,initiative:read');
    viewer = {
      id: 'lin-app',
      name: 'Dispatch',
      displayName: 'dispatch',
      app: true,
    } as typeof viewer;
    const done = await complete(start, 'linear', session);
    expect(done.headers.get('location')).toBe('/auth/linear/workspace');
    const ada = db.webSessionUser(session.slice('dt_session='.length))!;
    expect(installs).toHaveLength(1);
    expect(installs[0]?.userId).toBe(ada.id);
    expect(installs[0]?.record).toMatchObject({
      clientId: 'lin-client',
      accessToken: 'lin-token',
      refreshToken: 'lin-refresh',
      organization: ORG,
      user: { id: 'lin-app', email: 'lin-app@users.linear.app' },
    });
    // The app's grant is the install's, never a person's read grant.
    expect(grants.member(ada.id, 'org-1')).toBeNull();
    expect(
      seen.some((x) => x.url === 'https://api.linear.app/oauth/revoke')
    ).toBe(false);
  });

  it('refuses a grant Linear does not call an app (actor=app stripped)', async () => {
    const session = cookieOf(
      await complete(await call('/auth/github'), 'github')
    );
    const start = await call('/auth/linear/install', {
      headers: { cookie: session },
    });
    const done = await complete(start, 'linear', session);
    expect(done.status).toBe(403);
    expect(installs).toHaveLength(0);
    // The person's own token is not kept either.
    expect(
      seen.some((x) => x.url === 'https://api.linear.app/oauth/revoke')
    ).toBe(true);
  });

  it('records who a member is, so their teammate token names them', async () => {
    viewer = {
      id: 'lin-grace',
      name: 'Grace Hopper',
      displayName: 'grace',
      email: 'grace@acme.test',
      guest: true,
    } as typeof viewer;
    const done = await complete(await call('/auth/linear/workspace'), 'linear');
    const user = db.webSessionUser(cookieOf(done).slice('dt_session='.length))!;
    expect(grants.profile(user.id, 'org-1')).toEqual({
      name: 'Grace Hopper',
      displayName: 'grace',
      email: 'grace@acme.test',
      guest: true,
      admin: false,
    });
  });
});
