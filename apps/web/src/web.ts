import type { LinearAccountRecord } from '@dispatch-foo/core';
import { createHash, randomBytes } from 'node:crypto';

import type { Identity, TeamDb, User } from './db.js';
import type { TeamLinear } from './linear.js';
import {
  accountPage,
  APP_JS,
  devicePage,
  homePage,
  joinPage,
  messagePage,
  PAGE_CSP,
  signedInPage,
  signInPage,
  teamPage,
} from './pages.js';
import type { LiveSession } from './pages.js';
import type {
  GrantTokens,
  LinearGrants,
  LinearProfile,
} from './planner/grants.js';

// The browser side of the team service (GitHub and Linear sign-in, account
// linking, teams, invites, the device approval page) and the device-code API an
// MCP server signs in with.

export interface WebConfig {
  /** The public origin, e.g. https://team.dispatch.foo. */
  origin: string;
  githubClientId: string | null;
  githubClientSecret: string | null;
  /** The public Linear OAuth app (PKCE, no secret). Null hides Linear sign-in. */
  linearClientId?: string | null;
  /** The Linear app's secret, sent with a code exchange when set (an
   * `actor=app` install may need it). */
  linearClientSecret?: string | null;
  /** Lets /auth/dev sign anyone in by name: tests and local runs only. */
  devLogin: boolean;
}

export interface WebDeps {
  db: TeamDb;
  config: WebConfig;
  /** Live agent sessions on a team, for its page. */
  sessions: (teamId: string) => LiveSession[];
  /** The team's Linear connection. */
  linear?: TeamLinear;
  /** Called when a device is signed out, so its connection drops. */
  deviceRevoked?: (deviceId: string, teamId: string) => void;
  /** People's Linear read grants, for the hosted planner; absent when the
   * server cannot seal them. */
  grants?: LinearGrants;
  /** Installs Dispatch on a Linear workspace (its own hosted dispatchd);
   * absent when this server hosts none. */
  install?: (userId: string, record: LinearAccountRecord) => Promise<void>;
  /** GitHub's and Linear's endpoints, swappable in tests. */
  fetch?: typeof fetch;
}

const SESSION_COOKIE = 'dt_session';
const STATE_COOKIE = 'dt_oauth';
const LINEAR_STATE_COOKIE = 'dt_oauth_linear';
const LINEAR_AUTHORIZE = 'https://linear.app/oauth/authorize';
const LINEAR_API = 'https://api.linear.app';

// What an OAuth round trip is for: signing in, adding the provider to the
// account signed in (only ever started from a form on /account), or opening a
// Linear workspace in the hosted planner (which keeps the person's grant), or
// installing Dispatch on a workspace (an `actor=app` grant, by an admin).
type OAuthMode = 'signin' | 'link' | 'workspace' | 'install';

function cookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0)
      out.set(
        part.slice(0, i).trim(),
        decodeURIComponent(part.slice(i + 1).trim())
      );
  }
  return out;
}

function cookie(
  name: string,
  value: string,
  maxAgeSec: number,
  secure: boolean
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

function html(
  body: string,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
      ...headers,
    },
  });
}

function redirect(to: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location: to, ...headers },
  });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

// Only same-site paths may be a redirect target after sign-in: a leading
// "//" or any backslash (which browsers read as "/") could leave the site.
function safeNext(next: string | null): string {
  // Browsers drop tabs and newlines from URLs, so "/\t/evil" is "//evil".
  if (next === null || /[\s\\]/.test(next) || hasControlChar(next)) return '/';
  return /^\/(?!\/)/.test(next) ? next : '/';
}

// C0 controls and DEL: characters a browser strips from a URL before reading it.
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function form(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await req.text());
}

/** The person a browser request is signed in as, if any. */
export function webUserOf(db: TeamDb, req: Request): User | null {
  const value = cookies(req).get(SESSION_COOKIE);
  return value === undefined ? null : db.webSessionUser(value);
}

export function webHandler(
  deps: WebDeps
): (req: Request) => Promise<Response | null> {
  const { db, config } = deps;
  const secure = config.origin.startsWith('https://');
  const github = deps.fetch ?? fetch;
  const linearClientId = config.linearClientId ?? null;
  const linearClientSecret = config.linearClientSecret ?? null;

  function signedIn(req: Request): User | null {
    return webUserOf(db, req);
  }

  // A form a page of this site posted, not one from elsewhere riding the cookie.
  function sameOrigin(req: Request): boolean {
    const origin = req.headers.get('origin');
    return origin === null || origin === config.origin;
  }

  function signIn(user: User, next: string): Response {
    return redirect(next, {
      'set-cookie': cookie(
        SESSION_COOKIE,
        db.startWebSession(user.id),
        30 * 86_400,
        secure
      ),
    });
  }

  function expired(): Response {
    return html(
      messagePage(
        null,
        'Sign-in failed',
        'The sign-in link expired or did not match. Try again.'
      ),
      400
    );
  }

  function stateMatches(
    expected: string | undefined,
    got: string | null
  ): boolean {
    return expected !== undefined && expected !== '' && got === expected;
  }

  function notSetUp(provider: string): Response {
    return html(
      messagePage(
        null,
        'Sign-in is not set up',
        `This server has no ${provider} OAuth app configured.`
      ),
      503
    );
  }

  function startGithub(next: string, mode: OAuthMode): Response {
    if (config.githubClientId === null) return notSetUp('GitHub');
    const state = randomBytes(16).toString('base64url');
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', config.githubClientId);
    target.searchParams.set(
      'redirect_uri',
      `${config.origin}/auth/github/callback`
    );
    target.searchParams.set('scope', 'read:user');
    target.searchParams.set('state', state);
    return redirect(target.toString(), {
      'set-cookie': cookie(
        STATE_COOKIE,
        `${state} ${next} ${mode}`,
        600,
        secure
      ),
    });
  }

  // Linear's public "Dispatch" app has no client secret, so the code is bound
  // to this browser by PKCE: the verifier rides in the flow's HttpOnly cookie
  // and only its S256 challenge goes to Linear.
  function startLinear(next: string, mode: OAuthMode): Response {
    if (linearClientId === null) return notSetUp('Linear');
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const target = new URL(LINEAR_AUTHORIZE);
    target.searchParams.set('client_id', linearClientId);
    target.searchParams.set(
      'redirect_uri',
      `${config.origin}/auth/linear/callback`
    );
    target.searchParams.set('response_type', 'code');
    // Opening and installing keep the grant, and edits go back to Linear.
    // An app user reads initiatives only with their own scope, which a
    // person's `read` already covers.
    target.searchParams.set(
      'scope',
      mode === 'install'
        ? 'read,write,initiative:read'
        : mode === 'workspace'
          ? 'read,write'
          : 'read'
    );
    if (mode === 'install') target.searchParams.set('actor', 'app');
    target.searchParams.set('state', state);
    target.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url')
    );
    target.searchParams.set('code_challenge_method', 'S256');
    return redirect(target.toString(), {
      'set-cookie': cookie(
        LINEAR_STATE_COOKIE,
        `${state} ${next} ${mode} ${verifier}`,
        600,
        secure
      ),
    });
  }

  async function githubIdentity(
    code: string
  ): Promise<{ id: number; login: string; name: string | null }> {
    const tokenRes = await github(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
          redirect_uri: `${config.origin}/auth/github/callback`,
        }),
      }
    );
    const { access_token } = (await tokenRes.json()) as {
      access_token?: string;
    };
    if (access_token === undefined) throw new Error('no access token');
    const userRes = await github('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dispatch-team',
      },
    });
    const gh = (await userRes.json()) as {
      id?: number;
      login?: string;
      name?: string | null;
    };
    if (typeof gh.id !== 'number' || typeof gh.login !== 'string')
      throw new Error('no GitHub user');
    return { id: gh.id, login: gh.login, name: gh.name ?? null };
  }

  // Trades the code for a token and reads who and which workspace it belongs
  // to. A sign-in needs only the identity, so the token is revoked unless
  // `keep` (opening a workspace, where it becomes the person's read grant).
  async function linearAuthorize(
    code: string,
    verifier: string,
    keep: boolean,
    install = false
  ): Promise<{
    viewer: { id: string; displayName: string; name: string | null };
    /** The grant acts as an app (an `actor=app` install), not a person. */
    isApp: boolean;
    profile: LinearProfile;
    organization: { id: string; name: string; urlKey: string } | null;
    tokens: GrantTokens;
    scope: string[];
  }> {
    const tokenRes = await github(`${LINEAR_API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.origin}/auth/linear/callback`,
        client_id: linearClientId ?? '',
        code_verifier: verifier,
        ...(linearClientSecret === null
          ? {}
          : { client_secret: linearClientSecret }),
      }).toString(),
    });
    const token = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string | string[];
      error?: string;
      error_description?: string;
    };
    if (token.access_token === undefined)
      throw new Error(
        `no access token (${String(tokenRes.status)} ${token.error ?? ''} ${token.error_description ?? ''})`
      );
    const auth = { authorization: `Bearer ${token.access_token}` };
    let kept = false;
    try {
      const res = await github(`${LINEAR_API}/graphql`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            // `app` is asked only on an install, so a sign-in never
            // depends on it.
            `{ viewer { id name displayName email guest admin${install ? ' app' : ''} } organization { id name urlKey } }`,
        }),
      });
      const { data, errors } = (await res.json()) as {
        errors?: { message?: string }[];
        data?: {
          viewer?: {
            id?: string;
            name?: string | null;
            displayName?: string;
            email?: string | null;
            guest?: boolean;
            admin?: boolean;
            app?: boolean;
          };
          organization?: { id?: string; name?: string; urlKey?: string };
        };
      };
      const v = data?.viewer;
      if (typeof v?.id !== 'string' || typeof v.displayName !== 'string')
        throw new Error(
          `no Linear user (${errors?.map((e) => e.message ?? '').join('; ') ?? ''})`
        );
      const o = data?.organization;
      const organization =
        typeof o?.id === 'string' &&
        typeof o.name === 'string' &&
        typeof o.urlKey === 'string' &&
        /^[a-z0-9-]{1,64}$/.test(o.urlKey)
          ? { id: o.id, name: o.name, urlKey: o.urlKey }
          : null;
      kept = keep && organization !== null && (!install || v.app === true);
      return {
        viewer: { id: v.id, displayName: v.displayName, name: v.name ?? null },
        isApp: v.app === true,
        profile: {
          name: v.name ?? v.displayName,
          displayName: v.displayName,
          // The app user an install acts as has no mailbox; one is needed
          // only to name a member's teammate token.
          email:
            typeof v.email === 'string' && v.email.includes('@')
              ? v.email
              : `${v.id}@users.linear.app`,
          guest: v.guest === true,
          admin: v.admin === true,
        },
        scope:
          typeof token.scope === 'string'
            ? token.scope.split(/[ ,]+/).filter((x) => x !== '')
            : Array.isArray(token.scope)
              ? token.scope
              : [],
        organization,
        tokens: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          expiresAt:
            typeof token.expires_in === 'number'
              ? Date.now() + token.expires_in * 1000
              : null,
        },
      };
    } finally {
      if (!kept)
        await github(`${LINEAR_API}/oauth/revoke`, {
          method: 'POST',
          headers: auth,
        }).catch(() => undefined);
    }
  }

  // Finishes "Open a Linear workspace": keeps the read grant for the account
  // signed in, or signs the Linear user in first, then opens the planner. The
  // Linear identity joins a signed-in account when no other account holds it.
  function openWorkspace(
    req: Request,
    authorized: Awaited<ReturnType<typeof linearAuthorize>>
  ): Response {
    const { viewer, organization, tokens } = authorized;
    if (organization === null || deps.grants === undefined)
      return html(
        messagePage(
          null,
          'Could not open the workspace',
          'Linear did not name a workspace. Try again.'
        ),
        502
      );
    const current = signedIn(req);
    const user =
      current ??
      db.upsertLinearUser(viewer.id, viewer.displayName, viewer.name);
    if (current !== null && !db.identities(current.id).linear)
      db.linkIdentity(current.id, { provider: 'linear', id: viewer.id });
    deps.grants.save(
      user.id,
      organization,
      viewer.id,
      tokens,
      authorized.profile
    );
    const to = `/w/${organization.urlKey}/`;
    return current === null ? signIn(user, to) : redirect(to);
  }

  // Finishes "Install Dispatch": the app's grant becomes the workspace's own
  // planner connection, then the installer opens the workspace as themselves
  // (a second round trip: the install's grant is the app's, not theirs).
  // Linear lets only a workspace admin approve an `actor=app` install.
  async function installWorkspace(
    req: Request,
    authorized: Awaited<ReturnType<typeof linearAuthorize>>
  ): Promise<Response> {
    const user = signedIn(req);
    const { organization, tokens, viewer, profile } = authorized;
    const failed = (text: string, status: number) =>
      html(messagePage(user, 'Dispatch was not installed', text), status);
    if (user === null)
      return failed('Sign in first, then install from your home page.', 401);
    if (organization === null || deps.install === undefined)
      return failed('Linear did not name a workspace. Try again.', 502);
    // The authorize URL passed through the browser, so `actor=app` may have
    // been stripped: only Linear's word that this grant is the app's counts.
    if (!authorized.isApp)
      return failed(
        'Linear did not install Dispatch as an app. Only a workspace admin can install it.',
        403
      );
    if (tokens.refreshToken === null)
      return failed(
        'Linear gave no refresh token, so the install would stop working within a day. Try again.',
        502
      );
    const at = new Date().toISOString();
    try {
      await deps.install(user.id, {
        version: 1,
        clientId: linearClientId ?? '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(
          tokens.expiresAt ?? Date.now() + 86_400_000
        ).toISOString(),
        scope:
          authorized.scope.length > 0 ? authorized.scope : ['read', 'write'],
        user: { id: viewer.id, ...profile },
        organization,
        signedInAt: at,
        refreshedAt: null,
      });
    } catch {
      return failed(
        'The workspace planner did not start. Try installing again in a minute.',
        502
      );
    }
    return redirect('/auth/linear/workspace');
  }

  // Finishes a link flow: the identity joins the account signed in now. A flow
  // that outlived its session links nothing, and an identity another account
  // holds is refused, naming that account.
  function link(req: Request, identity: Identity, provider: string): Response {
    const user = signedIn(req);
    if (user === null)
      return html(
        messagePage(
          null,
          'Signed out',
          `Sign in again, then connect ${provider} from your account page.`
        ),
        401
      );
    const result = db.linkIdentity(user.id, identity);
    if (!result.ok)
      return html(
        messagePage(
          user,
          `That ${provider} account is taken`,
          `It already signs in to the Dispatch account ${result.owner.login}. Sign in with ${provider} to use that account instead.`
        ),
        409
      );
    return redirect('/account');
  }

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === '/app.js' && method === 'GET')
      return new Response(APP_JS, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });

    // ---- device-code API (RFC 8628), called by MCP servers ----
    if (path === '/api/device/code' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { client?: unknown };
      const client =
        typeof body.client === 'string' && body.client.trim() !== ''
          ? body.client
          : 'agent';
      const started = db.startDeviceCode(client);
      return json(200, {
        device_code: started.deviceCode,
        user_code: started.userCode,
        verification_uri: `${config.origin}/device`,
        verification_uri_complete: `${config.origin}/device?code=${started.userCode}`,
        expires_in: started.expiresIn,
        interval: 3,
      });
    }
    if (path === '/api/device/token' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        device_code?: unknown;
      };
      if (typeof body.device_code !== 'string')
        return json(400, { error: 'invalid_request' });
      const claimed = db.claimDevice(body.device_code);
      if (claimed.status !== 'ok') {
        const error = {
          pending: 'authorization_pending',
          denied: 'access_denied',
          expired: 'expired_token',
        }[claimed.status];
        return json(400, { error });
      }
      return json(200, {
        token: claimed.token,
        device: claimed.device.id,
        handle: claimed.user.login,
        team: { id: claimed.team.id, name: claimed.team.name },
      });
    }

    // ---- sign-in ----
    if (path === '/auth/github' && method === 'GET')
      return startGithub(safeNext(url.searchParams.get('next')), 'signin');
    if (path === '/auth/linear/workspace' && method === 'GET') {
      if (deps.grants === undefined)
        return html(
          messagePage(
            null,
            'Workspaces are not set up',
            'This server cannot hold Linear grants: it has no TEAM_SECRET or no Linear app.'
          ),
          503
        );
      return startLinear('/', 'workspace');
    }
    if (path === '/auth/linear/install' && method === 'GET') {
      if (deps.install === undefined || deps.grants === undefined)
        return html(
          messagePage(
            null,
            'Installs are not set up',
            'This server does not host workspace planners.'
          ),
          503
        );
      if (signedIn(req) === null)
        return redirect(
          `/auth/linear?next=${encodeURIComponent('/auth/linear/install')}`
        );
      return startLinear('/', 'install');
    }
    if (path === '/auth/linear' && method === 'GET')
      return startLinear(safeNext(url.searchParams.get('next')), 'signin');
    if (
      (path === '/auth/github/link' || path === '/auth/linear/link') &&
      method === 'POST'
    ) {
      const user = signedIn(req);
      if (user === null) return redirect('/');
      if (!sameOrigin(req))
        return html(
          messagePage(user, 'Refused', 'That form came from another site.'),
          403
        );
      return path === '/auth/github/link'
        ? startGithub('/account', 'link')
        : startLinear('/account', 'link');
    }
    if (path === '/auth/github/callback' && method === 'GET') {
      const [state, next, mode] = (cookies(req).get(STATE_COOKIE) ?? '').split(
        ' '
      );
      const code = url.searchParams.get('code');
      if (code === null || !stateMatches(state, url.searchParams.get('state')))
        return expired();
      let gh: { id: number; login: string; name: string | null };
      try {
        gh = await githubIdentity(code);
      } catch {
        return html(
          messagePage(
            null,
            'Sign-in failed',
            'GitHub did not confirm the sign-in. Try again.'
          ),
          502
        );
      }
      if (mode === 'link')
        return link(req, { provider: 'github', id: gh.id }, 'GitHub');
      return signIn(
        db.upsertGithubUser(gh.id, gh.login, gh.name),
        safeNext(next ?? null)
      );
    }
    if (path === '/auth/linear/callback' && method === 'GET') {
      const [state, next, mode, verifier] = (
        cookies(req).get(LINEAR_STATE_COOKIE) ?? ''
      ).split(' ');
      const code = url.searchParams.get('code');
      if (
        code === null ||
        verifier === undefined ||
        !stateMatches(state, url.searchParams.get('state'))
      )
        return expired();
      let authorized: Awaited<ReturnType<typeof linearAuthorize>>;
      try {
        authorized = await linearAuthorize(
          code,
          verifier,
          mode === 'workspace' || mode === 'install',
          mode === 'install'
        );
      } catch (err) {
        // The reason only, never a token: Linear's error codes and messages.
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'linear.oauth.failed',
            mode,
            reason: (err as Error).message,
          })
        );
        return html(
          messagePage(
            null,
            'Sign-in failed',
            'Linear did not confirm the sign-in. Try again.'
          ),
          502
        );
      }
      const { viewer } = authorized;
      if (mode === 'link')
        return link(req, { provider: 'linear', id: viewer.id }, 'Linear');
      if (mode === 'workspace') return openWorkspace(req, authorized);
      if (mode === 'install') return installWorkspace(req, authorized);
      return signIn(
        db.upsertLinearUser(viewer.id, viewer.displayName, viewer.name),
        safeNext(next ?? null)
      );
    }
    if (path === '/auth/dev' && method === 'GET' && config.devLogin) {
      const login = url.searchParams.get('login') ?? '';
      if (login === '')
        return html(
          messagePage(null, 'Dev sign-in', 'Pass ?login=<name>.'),
          400
        );
      // A stable fake GitHub id per name, far above real ids.
      let n = 0;
      for (const c of login) n = (n * 31 + c.charCodeAt(0)) % 1_000_000_000;
      return signIn(
        db.upsertGithubUser(10_000_000_000 + n, login, null),
        safeNext(url.searchParams.get('next'))
      );
    }
    if (path === '/auth/logout' && method === 'POST') {
      const value = cookies(req).get(SESSION_COOKIE);
      if (value !== undefined) db.endWebSession(value);
      return redirect('/', {
        'set-cookie': cookie(SESSION_COOKIE, '', 0, secure),
      });
    }

    // ---- pages that need a signed-in person ----
    const isPage =
      path === '/' ||
      path === '/account' ||
      path === '/teams' ||
      path.startsWith('/teams/') ||
      path.startsWith('/join/') ||
      path === '/device';
    if (!isPage) return null;
    const user = signedIn(req);
    if (user === null) {
      if (method !== 'GET') return redirect('/');
      return html(
        signInPage(path + url.search, config.devLogin, linearClientId !== null)
      );
    }
    if (method === 'POST' && !sameOrigin(req))
      return html(
        messagePage(user, 'Refused', 'That form came from another site.'),
        403
      );

    if (path === '/account' && method === 'GET')
      return html(
        accountPage(user, db.identities(user.id), {
          github: config.githubClientId !== null,
          linear: linearClientId !== null,
        })
      );
    if (path === '/' && method === 'GET') {
      const teams = db.teamsOf(user.id);
      // One team: that is where you are going.
      if (teams.length === 1 && url.searchParams.get('all') === null)
        return redirect(`/teams/${teams[0]?.id ?? ''}`);
      return html(
        homePage(user, teams, {
          workspaces: deps.grants?.workspacesOf(user.id) ?? [],
          canOpen: deps.grants !== undefined,
          canInstall: deps.grants !== undefined && deps.install !== undefined,
        })
      );
    }
    if (path === '/teams' && method === 'POST') {
      const name = ((await form(req)).get('name') ?? '').trim().slice(0, 80);
      if (name === '') return redirect('/');
      return redirect(`/teams/${db.createTeam(name, user.id).id}`);
    }

    const teamMatch = /^\/teams\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (teamMatch !== null) {
      const teamId = teamMatch[1] ?? '';
      const rest = teamMatch[2] ?? '';
      const team = db.team(teamId);
      const role = team === null ? null : db.role(teamId, user.id);
      if (team === null || role === null)
        return html(messagePage(user, 'Not found', 'No such team.'), 404);
      if (rest === '' && method === 'GET') {
        return html(
          teamPage({
            user,
            team,
            role,
            members: db.members(teamId),
            devices: db.devicesOf(teamId),
            sessions: deps.sessions(teamId),
            invite: url.searchParams.get('invite'),
            origin: config.origin,
            linear: {
              available: deps.linear?.available ?? false,
              status: deps.linear?.status(teamId) ?? null,
              error: url.searchParams.get('linear_error'),
            },
          })
        );
      }
      if (
        rest === 'linear' &&
        method === 'POST' &&
        role === 'admin' &&
        deps.linear !== undefined
      ) {
        const key = (await form(req)).get('key') ?? '';
        try {
          await deps.linear.connect(teamId, key, user.id);
          return redirect(`/teams/${teamId}`);
        } catch (err) {
          return redirect(
            `/teams/${teamId}?linear_error=${encodeURIComponent((err as Error).message.slice(0, 200))}`
          );
        }
      }
      if (
        rest === 'linear/disconnect' &&
        method === 'POST' &&
        role === 'admin' &&
        deps.linear !== undefined
      ) {
        await deps.linear.disconnect(teamId);
        return redirect(`/teams/${teamId}`);
      }
      if (rest === 'invites' && method === 'POST' && role === 'admin')
        return redirect(
          `/teams/${teamId}?invite=${encodeURIComponent(db.createInvite(teamId, user.id))}`
        );
      const removeMatch = /^members\/([^/]+)\/remove$/.exec(rest);
      if (removeMatch !== null && method === 'POST' && role === 'admin') {
        const gone = removeMatch[1] ?? '';
        for (const d of db.devicesOf(teamId))
          if (d.userId === gone) deps.deviceRevoked?.(d.id, teamId);
        db.removeMember(teamId, gone);
        return redirect(`/teams/${teamId}`);
      }
      const revokeMatch = /^devices\/([^/]+)\/revoke$/.exec(rest);
      if (revokeMatch !== null && method === 'POST') {
        const deviceId = revokeMatch[1] ?? '';
        const device = db.devicesOf(teamId).find((d) => d.id === deviceId);
        if (
          device !== undefined &&
          (role === 'admin' || device.userId === user.id)
        ) {
          db.revokeDevice(deviceId);
          deps.deviceRevoked?.(deviceId, teamId);
        }
        return redirect(`/teams/${teamId}`);
      }
      return html(messagePage(user, 'Not found', 'No such page.'), 404);
    }

    const joinMatch = /^\/join\/([^/]+)$/.exec(path);
    if (joinMatch !== null) {
      const token = joinMatch[1] ?? '';
      if (method === 'GET') {
        const team = db.inviteTeam(token);
        return team === null
          ? html(
              messagePage(
                user,
                'Invite not valid',
                'This invite is used, expired or unknown. Ask for a new one.'
              ),
              404
            )
          : html(joinPage(user, team, token));
      }
      const joined = db.acceptInvite(token, user.id);
      return joined.ok
        ? redirect(`/teams/${joined.team.id}`)
        : html(messagePage(user, 'Could not join', joined.reason), 409);
    }

    if (path === '/device') {
      const teams = db.teamsOf(user.id);
      if (method === 'GET') {
        const code = (url.searchParams.get('code') ?? '').trim();
        if (code === '') return html(devicePage(user, teams, '', null, null));
        const pending = db.pendingDevice(code);
        return pending === null
          ? html(
              devicePage(
                user,
                teams,
                code,
                null,
                'That code is not waiting for a sign-in (it may have expired).'
              ),
              404
            )
          : html(
              devicePage(user, teams, code.toUpperCase(), pending.client, null)
            );
      }
      const fields = await form(req);
      const code = fields.get('code') ?? '';
      if (fields.get('decision') === 'deny') {
        db.denyDevice(code);
        return html(messagePage(user, 'Denied', 'That sign-in was refused.'));
      }
      return db.approveDevice(code, user.id, fields.get('team') ?? '')
        ? html(
            signedInPage(
              user,
              db.team(fields.get('team') ?? '')?.name ?? 'your team'
            )
          )
        : html(
            devicePage(
              user,
              teams,
              code,
              null,
              'That code is not waiting for a sign-in, or you are not in that team.'
            ),
            400
          );
    }
    return null;
  };
}
