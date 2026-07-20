import { TaskStore } from '@dispatch/core';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApi } from './api.js';
import type { ApiContext } from './api.js';
import { TaskCache } from './cache.js';
import { removeDaemonFile, writeDaemonFile } from './daemonfile.js';
import { EventBus } from './events.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import { FakeExecutor } from './orchestrator/executors/fake.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
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
  // of the production default (ClaudeExecutor as 'claude', FakeExecutor as
  // 'fake'). Tests that dispatch through the real HTTP surface without
  // exercising the real Agent SDK (e.g. a request that omits `executor` and
  // so defaults to 'claude') use this to register a FakeExecutor under
  // 'claude' too — the point being that no test outside the explicitly-
  // gated DISPATCH_CLAUDE_SMOKE one ever invokes a real Claude session.
  registerExecutors?: (orchestrator: Orchestrator) => void;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(moduleDir, '..', 'package.json'), 'utf8')
) as { version: string };

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
  // Agent SDK executor) is the default per api.ts's createRun; 'fake' stays
  // registered alongside it as a scripted stand-in (a hidden dev toggle,
  // per the plan) so the full run lifecycle can be exercised through the
  // real HTTP/WS surface without spending real Claude budget. Tests
  // override this via `registerExecutors` (see its doc comment).
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  if (opts.registerExecutors !== undefined) {
    opts.registerExecutors(orchestrator);
  } else {
    orchestrator.registerExecutor('claude', new ClaudeExecutor());
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            entry: {
              ts: new Date().toISOString(),
              kind: 'assistant',
              text: 'FakeExecutor: simulating a dispatch run.',
            },
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
  }
  // Boot-time hygiene (spec §4): any run left non-terminal by a previous
  // crash is marked failed, and worktree directories with no matching
  // transcript at all are pruned.
  orchestrator.reconcileOnBoot();

  const apiCtx: ApiContext = {
    rootDir,
    store,
    cache,
    events,
    orchestrator,
    version: packageJson.version,
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        if (srv.upgrade(req)) return undefined;
        return new Response('expected websocket upgrade', { status: 400 });
      }

      if (url.pathname.startsWith('/api/')) {
        return handleApi(req, apiCtx);
      }

      if (webDistDir !== null) {
        const staticResponse = await serveStatic(url.pathname, webDistDir);
        if (staticResponse !== null) return staticResponse;
      }

      return new Response('not found', { status: 404 });
    },
    // Without this, an error escaping `fetch` falls to Bun's development
    // error page, which embeds the stack trace, absolute paths, and source
    // snippets in the response body. Loopback-only or not, responses must
    // never carry stack traces — log server-side, return opaque JSON.
    error(err) {
      console.error(`dispatchd: unexpected error: ${(err as Error).message}`);
      return new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
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
