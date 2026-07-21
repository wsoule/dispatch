import { TaskStore } from '@dispatch/core';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json';
import { handleApi } from './api.js';
import type { ApiContext } from './api.js';
import { TaskCache } from './cache.js';
import { removeDaemonFile, writeDaemonFile } from './daemonfile.js';
import { EventBus } from './events.js';
import { EpicEngine } from './orchestrator/epic.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { PlanManager } from './orchestrator/plan.js';
import { ClaudePlanner } from './orchestrator/planners/claude.js';
import type { CommandRunner } from './orchestrator/pr.js';
import { detectPrCapability, PrManager } from './orchestrator/pr.js';
import { watchTasks } from './watcher.js';

export interface ServerHandle {
  port: number;
  // Closes WS clients, stops the watcher, and removes the daemon file (if one
  // was written) — the reverse of everything startServer sets up.
  stop(): Promise<void>;
}

export interface StartServerOptions {
  rootDir: string;
  // 0 = ephemeral port, assigned by the OS; tests always pass this so
  // multiple server instances can run concurrently without colliding.
  port?: number;
  // Directory of the built web UI's static assets. `null` disables static
  // serving entirely (e.g. in server-only tests). Left `undefined`, it
  // resolves to the sibling `@dispatch/web` package's `dist/` — which won't
  // exist until Slice S3 builds it, in which case static serving is a no-op
  // 404 fallthrough rather than an error.
  webDistDir?: string | null;
  // Tests pass false so parallel test runs don't fight over the one
  // per-rootDir daemon file.
  writeDaemonFile?: boolean;
  // Overrides which executors get registered on the orchestrator, in place
  // of the production default (ClaudeExecutor as 'claude' only — Phase 7
  // moved FakeExecutor's registration behind bin.ts's DISPATCH_ENABLE_FAKES
  // gate rather than always registering it here). Tests that dispatch
  // through the real HTTP surface without exercising the real Agent SDK
  // (e.g. a request that omits `executor` and so defaults to 'claude') use
  // this to register a FakeExecutor under 'claude' too — the point being
  // that no test outside the explicitly-gated DISPATCH_CLAUDE_SMOKE one ever
  // invokes a real Claude session.
  registerExecutors?: (orchestrator: Orchestrator) => void;
  // Phase 5 P1, revised Phase 7: overrides which planners get registered on
  // the PlanManager, in place of the production default (ClaudePlanner as
  // 'claude' only). Tests override with a FakePlanner (see
  // orchestrator/planners/fake.ts) registered under 'claude' so nothing
  // outside a DISPATCH_CLAUDE_SMOKE-style gate ever calls the real Agent
  // SDK's plan mode; bin.ts's DISPATCH_ENABLE_FAKES gate additionally
  // registers a 'fake' planner alongside the real one for CLI e2e testing.
  registerPlanners?: (planManager: PlanManager) => void;
  // Overrides PrManager's gh/git seam and its capability-detection seam
  // (both take the same CommandRunner shape) so tests can exercise the PR
  // review path without a real GitHub remote or a logged-in gh CLI.
  prCommandRunner?: CommandRunner;
  // How often PrManager polls open PRs for a merged state. Defaults to the
  // plan's 60s; tests pass something much shorter.
  prPollIntervalMs?: number;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WEB_DIST_DIR = join(moduleDir, '..', '..', 'web', 'dist');

// Rebuilds `cache` from `store`, and never lets a rebuild kill the daemon:
// per-file parse failures are logged once each (they're also surfaced via
// `cache.problems()` at `GET /api/health`), and if the rebuild throws outright
// — e.g. the tasks directory itself is unreadable for a moment — that's
// logged too and the previous (last-good) cache contents are simply left in
// place, since `TaskCache.rebuild` only mutates its table after a successful
// scan. This runs both at boot and on every watcher-triggered change, which
// is exactly where the reviewer reproduced a crash: a bad file must degrade
// service, not end the process.
function safeRebuild(store: TaskStore, cache: TaskCache): void {
  try {
    const errors = cache.rebuild(store);
    for (const err of errors) {
      console.error(
        `dispatchd: skipping unparsable task file ${err.file}: ${err.message}`
      );
    }
  } catch (err) {
    console.error(
      `dispatchd: cache rebuild failed, keeping last-good cache: ${(err as Error).message}`
    );
  }
}

// Returns the origin to echo back in `Access-Control-Allow-Origin`, or null if
// the origin is not trusted (so no CORS header is sent and the browser blocks
// it). A wildcard `*` would be dangerous here: this daemon dispatches coding
// agents, so any web page you visit could otherwise fetch `127.0.0.1:<port>`
// and read your tasks or trigger a run (the loopback DNS-rebinding class). We
// trust only the app's own webview origins and loopback dev origins; a real
// site like `https://evil.com` matches none of these, so its reads are blocked
// and its JSON mutations never pass preflight.
export function resolveCorsOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  // Packaged Tauri webview (scheme varies by platform).
  if (
    origin === 'tauri://localhost' ||
    origin === 'https://tauri.localhost' ||
    origin === 'http://tauri.localhost'
  ) {
    return origin;
  }
  // Loopback dev origins (vite dev server / browser dev harness), any port.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  return null;
}

// Adds CORS headers so the desktop webview / browser dev harness (a different
// origin than `http://127.0.0.1:<port>`) can read this daemon's responses,
// but ONLY for trusted origins (see resolveCorsOrigin). Mutating the existing
// response's headers keeps streamed bodies (Bun.file static responses) intact.
function withCors(res: Response, origin: string | null): Response {
  const allowed = resolveCorsOrigin(origin);
  if (allowed !== null) {
    res.headers.set('access-control-allow-origin', allowed);
    res.headers.set(
      'access-control-allow-methods',
      'GET, POST, PATCH, OPTIONS'
    );
    res.headers.set('access-control-allow-headers', 'content-type');
    // The allowed origin is request-dependent, so caches must key on it.
    res.headers.set('vary', 'origin');
  }
  return res;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Serves a built web UI out of `webDistDir`, falling back to `index.html` for
// any non-file path so client-side routes work on a hard refresh (a classic
// SPA fallback). Returns null if nothing in `webDistDir` matches, so the
// caller can fall through to a plain 404.
async function serveStatic(
  pathname: string,
  webDistDir: string
): Promise<Response | null> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = Bun.file(join(webDistDir, relative));
  if (await candidate.exists()) {
    const type = CONTENT_TYPES[extname(relative)];
    return new Response(
      candidate,
      type !== undefined ? { headers: { 'content-type': type } } : {}
    );
  }
  const indexFile = Bun.file(join(webDistDir, 'index.html'));
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: { 'content-type': CONTENT_TYPES['.html'] },
    });
  }
  return null;
}

/**
 * Boots the dispatchd HTTP + WebSocket server for one dispatch project
 * (`rootDir`): a Bun.serve instance backed by an in-memory task cache that is
 * rebuilt from `@dispatch/core`'s TaskStore on boot, after every API
 * mutation, and whenever the tasks directory changes on disk.
 */
export async function startServer(
  opts: StartServerOptions
): Promise<ServerHandle> {
  const { rootDir } = opts;
  const webDistDir =
    opts.webDistDir === undefined ? DEFAULT_WEB_DIST_DIR : opts.webDistDir;
  const shouldWriteDaemonFile = opts.writeDaemonFile ?? true;

  const store = new TaskStore(rootDir);
  const cache = new TaskCache();
  safeRebuild(store, cache);
  const events = new EventBus();

  // Rebuild + broadcast on any on-disk change, regardless of who made it.
  // API mutations below also rebuild + broadcast directly, so an API write
  // will make the watcher fire again for the same change — one `task.changed`
  // from the handler, one from the watcher noticing the write. We accept that
  // duplicate rather than adding a suppression window: clients treat
  // `task.changed` as "go refetch" with no payload, so a duplicate refetch is
  // harmless, and the plan calls this out as the deliberately simple option.
  const watcher = watchTasks(store.tasksDir, () => {
    safeRebuild(store, cache);
    events.broadcast({ type: 'task.changed' });
  });

  // The orchestrator's own executor registry: 'claude' (Slice O2's real
  // Agent SDK executor) is the production default per api.ts's createRun.
  // FakeExecutor is NOT registered by default (Phase 7) — bin.ts registers
  // it under 'fake' only when DISPATCH_ENABLE_FAKES=1, a test/e2e-only hook.
  // Tests override this default entirely via `registerExecutors` (see its
  // doc comment) to register a FakeExecutor without going through bin.ts at
  // all.
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  if (opts.registerExecutors !== undefined) {
    opts.registerExecutors(orchestrator);
  } else {
    orchestrator.registerExecutor('claude', new ClaudeExecutor());
  }
  // Boot-time hygiene (spec §4): any run left non-terminal by a previous
  // crash is marked failed, and worktree directories with no matching
  // transcript at all are pruned.
  orchestrator.reconcileOnBoot();

  // Phase 5 P1, revised Phase 7: the planner registry (real ClaudePlanner
  // under 'claude' by default; tests/bin.ts's DISPATCH_ENABLE_FAKES override
  // via `registerPlanners`) and the epic dispatch engine, both wired against
  // the same store/cache/events/orchestrator every other request handler
  // shares.
  const planManager = new PlanManager({ store, cache, events });
  if (opts.registerPlanners !== undefined) {
    opts.registerPlanners(planManager);
  } else {
    planManager.registerPlanner('claude', new ClaudePlanner(rootDir));
  }
  const epicEngine = new EpicEngine({
    rootDir,
    store,
    cache,
    events,
    orchestrator,
  });

  // PR capability is detected once, here at boot, and never rechecked per
  // request — a project's gh/remote setup essentially never changes while
  // dispatchd is running, and re-shelling-out to `gh --version` on every
  // health check or review action would be wasted work.
  const prCapability = await detectPrCapability(rootDir, opts.prCommandRunner);
  const prManager = new PrManager(
    { rootDir, store, cache, events, orchestrator },
    prCapability,
    opts.prCommandRunner
  );
  prManager.startPolling(opts.prPollIntervalMs);

  const apiCtx: ApiContext = {
    rootDir,
    store,
    cache,
    events,
    orchestrator,
    version: packageJson.version,
    planManager,
    epicEngine,
    prManager,
    prCapability,
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get('origin');

      if (url.pathname === '/ws') {
        if (srv.upgrade(req)) return undefined;
        return withCors(
          new Response('expected websocket upgrade', { status: 400 }),
          origin
        );
      }

      // The desktop webview and the browser dev harness both fetch this daemon
      // cross-origin (webview origin vs `http://127.0.0.1:<port>`), so trusted
      // origins need CORS headers or the browser blocks the JS from reading the
      // response ("TypeError: Failed to fetch") — which manifested as the UI
      // hanging forever on "Loading board…". A JSON PATCH/POST triggers a
      // preflight; answer it here (untrusted origins get no CORS header and are
      // thus blocked).
      if (req.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }), origin);
      }

      if (url.pathname.startsWith('/api/')) {
        return withCors(await handleApi(req, apiCtx), origin);
      }

      if (webDistDir !== null) {
        const staticResponse = await serveStatic(url.pathname, webDistDir);
        if (staticResponse !== null) return withCors(staticResponse, origin);
      }

      return withCors(new Response('not found', { status: 404 }), origin);
    },
    // Without this, an error escaping `fetch` falls to Bun's development
    // error page, which embeds the stack trace, absolute paths, and source
    // snippets in the response body. Loopback-only or not, responses must
    // never carry stack traces — log server-side, return opaque JSON.
    error(err) {
      console.error(`dispatchd: unexpected error: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // Bun's error handler has no access to the request; a 500 body is
          // opaque anyway, so echo a wildcard-free permissive header only for
          // the app's own dev/webview origins is not possible here — omit CORS.
          // The browser will surface it as a network error, which is correct
          // for an unexpected server fault.
        },
      });
    },
    websocket: {
      open(ws) {
        events.add(ws);
        ws.send(
          JSON.stringify({ type: 'hello', version: packageJson.version })
        );
      },
      // The protocol is server -> client only; clients never send anything
      // meaningful, so incoming messages are ignored.
      message() {},
      close(ws) {
        events.remove(ws);
      },
    },
  });

  // `Server.port` is typed optional (Bun also serves over unix sockets, which
  // have no port); we always bind a TCP hostname:port above, so it is always
  // defined in practice. Falling back to 0 keeps the types honest without an
  // assertion.
  const port = server.port ?? 0;

  if (shouldWriteDaemonFile) {
    writeDaemonFile({
      rootDir,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  return {
    port,
    async stop() {
      watcher.close();
      prManager.stopPolling();
      // `server.stop(true)` force-closes every open connection, WebSockets
      // included — that fires our `websocket.close` handler for each client,
      // which removes it from `events` on the way out. See the note on
      // EventBus for why we don't also close each socket ourselves first.
      await server.stop(true);
      if (shouldWriteDaemonFile) removeDaemonFile(rootDir);
    },
  };
}

export type { ApiContext } from './api.js';
export { Orchestrator } from './orchestrator/orchestrator.js';
