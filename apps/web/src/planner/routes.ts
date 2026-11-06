import { randomBytes } from 'node:crypto';
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
const MAX_VIEW_TOKENS = 10_000;
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
function injected(html: string, config: Record<string, unknown>): string {
  const script = `<script>window.__DISPATCH_DEMO__=${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${script}</head>`)
    : script + html;
}

export interface Planner {
  /** Answers the planner's routes; null for any other path. */
  fetch: (req: Request) => Promise<Response | null>;
  /** Whether `token` may open `/w/<key>/ws`, the live-update socket. The
   * hosted planner sends no events yet; an open socket stops the app retrying. */
  watches: (key: string, token: string) => boolean;
}

export function plannerHandler(deps: PlannerDeps): Planner {
  const now = deps.now ?? Date.now;
  const tokens = new Map<
    string,
    {
      key: string;
      userId: string | null;
      linearUserId: string | null;
      expires: number;
    }
  >();
  const cache = new Map<string, { at: number; model: Promise<DaemonModel> }>();

  function mint(
    key: string,
    userId: string | null,
    linearUserId: string | null
  ): string {
    const at = now();
    if (tokens.size >= MAX_VIEW_TOKENS)
      for (const [t, v] of tokens) if (v.expires <= at) tokens.delete(t);
    if (tokens.size >= MAX_VIEW_TOKENS)
      tokens.delete(tokens.keys().next().value ?? '');
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, {
      key,
      userId,
      linearUserId,
      expires: at + VIEW_TOKEN_MS,
    });
    return token;
  }

  // One fetch a minute per workspace and person, shared by every request in
  // between. Per person, because Linear shows each one a different workspace.
  function model(
    key: string,
    userId: string | null,
    source: WorkspaceSource
  ): Promise<DaemonModel> {
    const slot = `${key}\u0000${userId ?? ''}`;
    const hit = cache.get(slot);
    if (hit !== undefined && now() - hit.at < CACHE_MS) return hit.model;
    const loading = source.load(userId);
    cache.set(slot, { at: now(), model: loading });
    loading.catch(() => cache.delete(slot));
    return loading;
  }

  function valid(
    key: string,
    token: string
  ): { userId: string | null; linearUserId: string | null } | null {
    const grant = tokens.get(token);
    return grant === undefined || grant.expires <= now() || grant.key !== key
      ? null
      : grant;
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
        header.startsWith('Bearer ') ? header.slice(7) : ''
      );
      if (grant === null || source === null)
        return json({ error: 'Open the planner again to continue.' }, 401);
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
    if (source === null || viewer === null)
      return json({ error: 'No such workspace.' }, 404);
    if (dist === null || !existsSync(join(dist, 'index.html')))
      return json({ error: 'The planner is not built on this server.' }, 503);
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

  return { fetch, watches: (key, token) => valid(key, token) !== null };
}
