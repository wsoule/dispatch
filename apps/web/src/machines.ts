import type { LinkHttpResponse, LinkProject } from '@dispatch-foo/protocol';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamDb, User } from './db.js';
import type { TeamHubs } from './hub.js';
import type { MachineRow } from './pages.js';
import { machinesPage, PAGE_CSP } from './pages.js';
import { injected } from './planner/routes.js';

// Your own machines from the web (phase 4). `/machines` lists the machines
// you signed in and the projects open on them; `/m/<device>/<project>/`
// serves the desktop app against that project's daemon, and its
// `/api/*` calls travel over the machine hub's team link (hub/web.ts on the
// machine), where the daemon replays them at the decide tier. Only a
// machine's own owner reaches it: every call checks the session's person
// against the device's, and the page's view token is bound to both.

const VIEW_TOKEN_MS = 12 * 3_600_000;
const PROJECTS_WAIT_MS = 5_000;
const CALL_WAIT_MS = 60_000;
/** Base64 grows a body by a third, and a frame is capped at 4 MiB. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FORWARDED = ['accept', 'content-type', 'if-match', 'if-none-match'];
const RETURNED = ['content-type', 'cache-control', 'etag', 'last-modified'];

export interface MachinesDeps {
  db: TeamDb;
  hubs: TeamHubs;
  origin: string;
  /** The desktop Vite bundle (apps/desktop/dist); null serves no page. */
  distDir: string | null;
  userOf: (req: Request) => User | null;
  /** The sign-in page, returning to `next` after. */
  signIn: (next: string) => Response;
  now?: () => number;
}

export interface Machines {
  /** Answers `/machines` and `/m/*`; null for any other path. */
  fetch: (req: Request) => Promise<Response | null>;
  /** Whether `token` may open `/m/<device>/<project>/ws` for this session. */
  watches: (
    device: string,
    project: string,
    token: string,
    req: Request
  ) => boolean;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function machinesHandler(deps: MachinesDeps): Machines {
  const now = deps.now ?? Date.now;
  // Signed, not stored: they die with the process, as the planner's do.
  const signingKey = randomBytes(32);
  const sign = (payload: string): string =>
    createHmac('sha256', signingKey).update(payload).digest('base64url');

  function mint(scope: string, userId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ s: scope, u: userId, e: now() + VIEW_TOKEN_MS })
    ).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function valid(scope: string, token: string, req: Request): User | null {
    const [payload, mac] = token.split('.');
    if (payload === undefined || mac === undefined) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    let grant: { s?: unknown; u?: unknown; e?: unknown };
    try {
      grant = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8')
      ) as typeof grant;
    } catch {
      return null;
    }
    if (grant.s !== scope || typeof grant.e !== 'number' || grant.e <= now())
      return null;
    const user = deps.userOf(req);
    return user !== null && user.id === grant.u ? user : null;
  }

  // The device, if it is this person's, still signed in, and connected now.
  function ownDevice(deviceId: string, user: User) {
    const device = deps.db
      .devicesOfUser(user.id)
      .find((d) => d.id === deviceId);
    if (device === undefined || !deps.db.deviceLive(device.id)) return null;
    return deps.hubs.of(device.teamId).connection(device.id);
  }

  async function list(user: User): Promise<MachineRow[]> {
    return Promise.all(
      deps.db.devicesOfUser(user.id).map(async (d): Promise<MachineRow> => {
        const conn = deps.hubs.of(d.teamId).connection(d.id);
        const row = {
          id: d.id,
          client: d.client,
          teamName: d.teamName,
          lastSeen: d.lastSeen,
          online: conn !== null,
          projects: null,
        };
        if (conn === null) return row;
        const answer = await conn.call('projects', {}, PROJECTS_WAIT_MS);
        if (!answer.ok)
          return {
            ...row,
            note:
              // Hubs older than web access drop the frame without a reply, so
              // a silent machine most likely needs the same update.
              answer.error === 'unknown frame kind' ||
              answer.error === 'the machine did not answer'
                ? 'This machine did not answer. Its Dispatch hub is probably older than web access; update it to reach it from the web.'
                : (answer.error ?? 'The machine did not answer.'),
          };
        const projects = (answer.result as { projects?: LinkProject[] })
          .projects;
        return { ...row, projects: Array.isArray(projects) ? projects : [] };
      })
    );
  }

  async function forward(
    deviceId: string,
    project: string,
    rest: string,
    req: Request,
    user: User
  ): Promise<Response> {
    const conn = ownDevice(deviceId, user);
    if (conn === null)
      return json({ error: 'That machine is offline or not yours.' }, 404);
    const bytes =
      req.method === 'GET' || req.method === 'HEAD'
        ? new Uint8Array()
        : new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES)
      return json({ error: 'That request is too large to send.' }, 413);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = req.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const answer = await conn.call(
      'http',
      {
        project,
        method: req.method,
        path: rest,
        headers,
        body: Buffer.from(bytes).toString('base64'),
      },
      CALL_WAIT_MS
    );
    if (!answer.ok)
      return json(
        { error: answer.error ?? 'The machine did not answer.' },
        502
      );
    const res = answer.result as Partial<LinkHttpResponse> | null;
    if (
      res === null ||
      typeof res.status !== 'number' ||
      res.status < 200 ||
      res.status > 599 ||
      typeof res.headers !== 'object' ||
      res.headers === null ||
      typeof res.body !== 'string'
    )
      return json({ error: 'The machine sent a broken answer.' }, 502);
    const out = new Headers({ 'cache-control': 'no-store' });
    for (const name of RETURNED) {
      const value = res.headers[name];
      if (typeof value === 'string') out.set(name, value);
    }
    return new Response(
      res.status === 204 || res.status === 304
        ? null
        : Buffer.from(res.body, 'base64'),
      { status: res.status, headers: out }
    );
  }

  const fetch = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/machines' && req.method === 'GET') {
      const user = deps.userOf(req);
      if (user === null) return deps.signIn('/machines');
      return new Response(machinesPage(user, await list(user)), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': PAGE_CSP,
          'cache-control': 'no-store',
        },
      });
    }
    const match = /^\/m\/(dev[A-Za-z0-9_-]{1,64})\/([0-9a-f]{16})(\/.*)?$/.exec(
      path
    );
    if (match === null) return null;
    const deviceId = match[1] ?? '';
    const project = match[2] ?? '';
    const rest = match[3] ?? '';
    const scope = `${deviceId}/${project}`;

    if (rest.startsWith('/api/')) {
      const header = req.headers.get('authorization') ?? '';
      const user = valid(
        scope,
        header.startsWith('Bearer ') ? header.slice(7) : '',
        req
      );
      if (user === null)
        return json({ error: 'Open the machine again to continue.' }, 401);
      return forward(deviceId, project, rest + url.search, req, user);
    }
    if (rest === '/ws')
      return json({ error: 'Open the machine again to continue.' }, 401);
    if (rest === '')
      return Response.redirect(`${deps.origin}/m/${scope}/`, 303);
    if (rest !== '/' || req.method !== 'GET') return null;

    const user = deps.userOf(req);
    if (user === null) return deps.signIn(`/m/${scope}/`);
    // Someone else's machine looks the same as one that does not exist.
    const conn = ownDevice(deviceId, user);
    if (conn === null)
      return json({ error: 'No such machine, or it is offline.' }, 404);
    // The app names a project by its root's last segment: ask the machine
    // for the project's own name, so the page reads `dispatch`, not the key.
    const listed = await conn.call('projects', {}, PROJECTS_WAIT_MS);
    const name =
      (
        listed.result as { projects?: LinkProject[] } | undefined
      )?.projects?.find((p) => p.key === project)?.name ?? project;
    const dist = deps.distDir;
    if (dist === null || !existsSync(join(dist, 'index.html')))
      return json({ error: 'The app is not built on this server.' }, 503);
    const html = await Bun.file(join(dist, 'index.html')).text();
    return new Response(
      injected(html, {
        baseUrl: `${deps.origin}/m/${scope}`,
        root: `/m/${scope}/${encodeURIComponent(name)}`,
        agentToken: mint(scope, user.id),
        appToken: null,
      }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      }
    );
  };

  return {
    fetch,
    watches: (device, project, token, req) =>
      valid(`${device}/${project}`, token, req) !== null,
  };
}
