import { DAEMON_DEFAULTS } from './daemonDefaults.js';
import type { DaemonModel } from './toDispatch.js';

// A hosted workspace answered as a read-only dispatchd: the desktop bundle
// talks to `<origin>/w/<key>` as its daemon. Planning data and identity come
// from the workspace's DaemonModel; the other routes the app polls answer as
// a fresh daemon does (daemonDefaults.ts); every write is refused.

export interface PlannerContext {
  /** The workspace key in the URL: `demo` or a Linear urlKey. */
  key: string;
  model: DaemonModel;
  /** The viewer's person ref in this workspace. */
  viewer: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

// Fresh-daemon answers, with the recorded root swapped for this workspace's.
function fallback(route: string, key: string): unknown {
  const value = DAEMON_DEFAULTS[route];
  return value === undefined
    ? undefined
    : (JSON.parse(
        JSON.stringify(value).replaceAll('/w/{key}', `/w/${key}`)
      ) as unknown);
}

const SETUP = {
  steps: [
    { id: 'git', status: 'ok', message: 'Hosted: no git needed.' },
    { id: 'project', status: 'ok', message: 'Your Linear workspace is ready.' },
    {
      id: 'agent',
      status: 'ok',
      message: 'Hosted planner: agents run on your machines.',
    },
  ],
  providers: [],
};

/** Answers one daemon API request (`path` with its query) for a workspace. */
export function plannerResponse(
  path: string,
  method: string,
  ctx: PlannerContext
): Response {
  const url = new URL(path, 'http://planner.invalid');
  const route = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (method !== 'GET' && method !== 'HEAD') {
    // The app reports which view has focus; there is no one to tell.
    if (route === 'presence/focus' && method === 'POST')
      return json({ ok: true });
    return json({ error: 'This hosted planner is read-only.' }, 403);
  }
  const { model } = ctx;
  const handle = ctx.viewer.replace(/^human:/, '');
  switch (route) {
    case 'tasks':
      return json(
        url.searchParams.get('fields') === 'meta'
          ? model.tasks.map((t) => ({ meta: t.meta }))
          : model.tasks
      );
    case 'config':
      return json({
        ...(fallback('config', ctx.key) as Record<string, unknown>),
        statuses: model.statusDefinitions.map((d) => d.name),
        statusDefinitions: model.statusDefinitions,
      });
    case 'whoami':
      return json({
        handle,
        ref: ctx.viewer,
        tier: 'request',
        agentToken: true,
      });
    case 'people':
      return json({ me: ctx.viewer, people: model.people });
    case 'linear/links':
      return json(model.links);
    case 'setup':
      return json(SETUP);
    case 'executors':
      return json({ executors: [], default: 'claude' });
    case 'presence':
      return json([]);
    // Operator-only on a daemon too: the request tier is refused them.
    case 'overseer/current':
    case 'memory/ingest-problems':
      return json({ error: 'Not available at this tier.' }, 403);
  }
  const task = /^tasks\/([te]-[0-9a-f]+)(\/comments)?$/.exec(route);
  if (task !== null) {
    if (task[2] !== undefined) return json([]);
    const doc = model.tasks.find((t) => t.meta.id === task[1]);
    return doc === undefined
      ? json({ error: 'No such task.' }, 404)
      : json(doc);
  }
  const value = fallback(route, ctx.key);
  return value === undefined ? json({ error: 'Not found.' }, 404) : json(value);
}
