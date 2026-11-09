import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { plannerResponse } from './api.js';
import { GrantGone } from './grants.js';
import type { DaemonModel } from './toDispatch.js';

// The hosted planner's HTTP surface. `/w/<key>/` serves the desktop's own
// bundle with a connection injected (as apps/demo does), pointing its daemon
// at `/w/<key>`. `/w/<key>/api/*` answers as that daemon, read-only, for the
// view token the page was given. `/assets/*` and the bundle's root files are
// the desktop dist.

/** Where a workspace's data comes from, and who may open it. */
export interface WorkspaceSource {
  name: string;
  /** Who a signed-in user (or nobody) is in this workspace; null when they
   * may not open it. */
  viewerFor(userId: string | null): { linearUserId: string | null } | null;
  /** The workspace as this user may see it (Linear shows each person only
   * the teams they belong to). */
  load(userId: string | null): Promise<DaemonModel>;
  /** Everyone sees the same workspace (the demo), so one copy serves all. */
  shared?: boolean;
  /** Starts the workspace's daemon, so the page's first calls find it up. */
  warm?: () => Promise<void>;
  /** Whether this person was a member whose membership has lapsed. */
  lapsed?: (userId: string) => boolean;
  /** Set when the workspace has its own dispatchd: its API answers there,
   * as the signed-in member, instead of from `load`. */
  daemon?: (
    userId: string | null,
    pathAndQuery: string,
    req: Request
  ) => Promise<Response>;
}

export interface PlannerDeps {
  origin: string;
  /** The desktop Vite bundle (apps/desktop/dist); null serves nothing. */
  distDir: string | null;
  /** The signed-in user id of a request, or null. */
  userOf: (req: Request) => string | null;
  /** A workspace by URL key, or null when there is none by that name. */
  workspace: (key: string) => WorkspaceSource | null;
  now?: () => number;
}

const VIEW_TOKEN_MS = 12 * 3_600_000;
const CACHE_MS = 60_000;
const BUNDLE_ROOT_FILES = new Set(['/favicon.svg', '/icons.svg']);

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

// A file under `dir` for a URL path, refusing anything that climbs out.
function inDir(dir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  const full = resolve(dir, `.${decoded}`);
  return full.startsWith(root) ? full : null;
}

// The connection the desktop reads at boot (lib/tauri.ts demoConfig), placed
// before its scripts. `<` is escaped so a value cannot close the tag.
export function injected(
  html: string,
  config: Record<string, unknown>
): string {
  const script = `<script>window.__DISPATCH_DEMO__=${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${script}</head>`)
    : script + html;
}

export interface Planner {
  /** Answers the planner's routes; null for any other path. */
  fetch: (req: Request) => Promise<Response | null>;
  /** Who `token` opens `/w/<key>/ws`, the live-update socket, for in this
   * request's session, or null when it may not. */
  watches: (
    key: string,
    token: string,
    req: Request
  ) => { userId: string | null } | null;
}

export function plannerHandler(deps: PlannerDeps): Planner {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; model: Promise<DaemonModel> }>();
  let swept = 0;
  // View tokens are signed, not stored: nothing to fill or evict, and they
  // die with the process (a restarted server asks pages to reopen).
  const signingKey = randomBytes(32);
  const sign = (payload: string): string =>
    createHmac('sha256', signingKey).update(payload).digest('base64url');

  function mint(
    key: string,
    userId: string | null,
    linearUserId: string | null
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        k: key,
        u: userId,
        l: linearUserId,
        e: now() + VIEW_TOKEN_MS,
      })
    ).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  // One fetch a minute per workspace and person, shared by every request in
  // between. Per person, because Linear shows each one a different workspace
  // (a shared source is one copy for all). Stale entries are swept a minute
  // at a time, so the cache holds only workspaces read in the last minute.
  function model(
    key: string,
    userId: string | null,
    source: WorkspaceSource
  ): Promise<DaemonModel> {
    const at = now();
    if (at - swept >= CACHE_MS) {
      swept = at;
      for (const [slot, entry] of cache)
        if (at - entry.at >= CACHE_MS) cache.delete(slot);
    }
    const slot = source.shared === true ? key : `${key}\u0000${userId ?? ''}`;
    const hit = cache.get(slot);
    if (hit !== undefined && at - hit.at < CACHE_MS) return hit.model;
    const loading = source.load(userId);
    const entry = { at, model: loading };
    cache.set(slot, entry);
    loading.catch(() => {
      if (cache.get(slot) === entry) cache.delete(slot);
    });
    return loading;
  }

  // A token is good for its workspace until it expires, and a signed-in
  // viewer's only while the request carries that same person's session: signing
  // out ends an open page's reads.
  function valid(
    key: string,
    token: string,
    req: Request
  ): { userId: string | null; linearUserId: string | null } | null {
    const [payload, mac] = token.split('.');
    if (payload === undefined || mac === undefined) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    let grant: { k?: unknown; u?: unknown; l?: unknown; e?: unknown };
    try {
      grant = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8')
      ) as typeof grant;
    } catch {
      return null;
    }
    if (grant.k !== key || typeof grant.e !== 'number' || grant.e <= now())
      return null;
    const userId = typeof grant.u === 'string' ? grant.u : null;
    if (userId !== null && deps.userOf(req) !== userId) return null;
    return {
      userId,
      linearUserId: typeof grant.l === 'string' ? grant.l : null,
    };
  }

  const fetch = async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const dist = deps.distDir;

    if (
      dist !== null &&
      (path.startsWith('/assets/') || BUNDLE_ROOT_FILES.has(path))
    ) {
      const file = inDir(dist, path);
      if (file === null || !(await Bun.file(file).exists())) return null;
      return new Response(Bun.file(file), {
        headers: {
          'cache-control': path.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      });
    }

    const match = /^\/w\/([a-z0-9-]{1,64})(\/.*)?$/.exec(path);
    if (match === null) return null;
    const key = match[1] ?? '';
    const rest = match[2] ?? '';
    const source = deps.workspace(key);

    if (rest.startsWith('/api/')) {
      const header = req.headers.get('authorization') ?? '';
      const grant = valid(
        key,
        header.startsWith('Bearer ') ? header.slice(7) : '',
        req
      );
      if (grant === null || source === null)
        return json({ error: 'Open the planner again to continue.' }, 401);
      if (source.daemon !== undefined) {
        // Checked on every request, not just when the page opened.
        if (source.viewerFor(grant.userId) === null)
          return json(
            {
              error:
                'Open the workspace from app.dispatch.foo again to continue.',
            },
            401
          );
        try {
          return await source.daemon(grant.userId, rest + url.search, req);
        } catch {
          return json(
            { error: 'The workspace did not answer. Try again in a minute.' },
            502
          );
        }
      }
      try {
        const data = await model(key, grant.userId, source);
        const viewer =
          data.people.find(
            (p) => p.external === `linear:${grant.linearUserId ?? ''}`
          )?.ref ?? 'human:guest';
        return plannerResponse(rest + url.search, req.method, {
          key,
          model: data,
          viewer,
        });
      } catch (err) {
        return err instanceof GrantGone
          ? json(
              {
                error:
                  'Your Linear access ended. Open the workspace from app.dispatch.foo again.',
              },
              401
            )
          : json(
              { error: 'Linear did not answer. Try again in a minute.' },
              502
            );
      }
    }
    if (rest === '/ws')
      return json({ error: 'Open the planner again to continue.' }, 401);
    if (rest === '') return Response.redirect(`${deps.origin}/w/${key}/`, 303);
    if (rest !== '/' || req.method !== 'GET') return null;

    // A workspace you may not open looks the same as one that does not exist.
    const userId = deps.userOf(req);
    const viewer = source?.viewerFor(userId) ?? null;
    // A member of an installed workspace confirms their membership through
    // Linear again (it lapses after a week). Only someone whose own grant
    // names it is told the workspace exists.
    if (viewer === null && userId !== null && source?.lapsed?.(userId) === true)
      return Response.redirect(`${deps.origin}/auth/linear/workspace`, 303);
    if (source === null || viewer === null)
      return json({ error: 'No such workspace.' }, 404);
    if (dist === null || !existsSync(join(dist, 'index.html')))
      return json({ error: 'The planner is not built on this server.' }, 503);
    if (source.warm !== undefined)
      try {
        await source.warm();
      } catch {
        return json(
          { error: 'The workspace is starting. Reload in a minute.' },
          503
        );
      }
    const html = await Bun.file(join(dist, 'index.html')).text();
    return new Response(
      injected(html, {
        baseUrl: `${deps.origin}/w/${key}`,
        root: `/w/${key}`,
        agentToken: mint(key, userId, viewer.linearUserId),
        appToken: null,
        hosted: { workspace: source.name },
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
    watches: (key, token, req) => valid(key, token, req),
  };
}
