import { randomBytes } from 'node:crypto';

import type { TeamDb, User } from './db.js';
import type { TeamLinear } from './linear.js';
import {
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

// The browser side of the team service (GitHub sign-in, teams, invites, the
// device approval page) and the device-code API an MCP server signs in with.

export interface WebConfig {
  /** The public origin, e.g. https://team.dispatch.foo. */
  origin: string;
  githubClientId: string | null;
  githubClientSecret: string | null;
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
  /** GitHub's endpoints, swappable in tests. */
  fetch?: typeof fetch;
}

const SESSION_COOKIE = 'dt_session';
const STATE_COOKIE = 'dt_oauth';

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
    if (path === '/auth/github' && method === 'GET') {
      if (config.githubClientId === null)
        return html(
          messagePage(
            null,
            'Sign-in is not set up',
            'This server has no GitHub OAuth app configured.'
          ),
          503
        );
      const state = randomBytes(16).toString('base64url');
      const next = safeNext(url.searchParams.get('next'));
      const target = new URL('https://github.com/login/oauth/authorize');
      target.searchParams.set('client_id', config.githubClientId);
      target.searchParams.set(
        'redirect_uri',
        `${config.origin}/auth/github/callback`
      );
      target.searchParams.set('scope', 'read:user');
      target.searchParams.set('state', state);
      return redirect(target.toString(), {
        'set-cookie': cookie(STATE_COOKIE, `${state} ${next}`, 600, secure),
      });
    }
    if (path === '/auth/github/callback' && method === 'GET') {
      const [state, next] = (cookies(req).get(STATE_COOKIE) ?? '').split(' ');
      const code = url.searchParams.get('code');
      if (
        code === null ||
        state === undefined ||
        state === '' ||
        url.searchParams.get('state') !== state
      )
        return html(
          messagePage(
            null,
            'Sign-in failed',
            'The sign-in link expired or did not match. Try again.'
          ),
          400
        );
      try {
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
        return signIn(
          db.upsertGithubUser(gh.id, gh.login, gh.name ?? null),
          safeNext(next ?? null)
        );
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
      path === '/teams' ||
      path.startsWith('/teams/') ||
      path.startsWith('/join/') ||
      path === '/device';
    if (!isPage) return null;
    const user = signedIn(req);
    if (user === null) {
      if (method !== 'GET') return redirect('/');
      return html(signInPage(path + url.search, config.devLogin));
    }
    if (method === 'POST' && !sameOrigin(req))
      return html(
        messagePage(user, 'Refused', 'That form came from another site.'),
        403
      );

    if (path === '/' && method === 'GET') {
      const teams = db.teamsOf(user.id);
      // One team: that is where you are going.
      if (teams.length === 1 && url.searchParams.get('all') === null)
        return redirect(`/teams/${teams[0]?.id ?? ''}`);
      return html(homePage(user, teams));
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
