import {
  ActorContext,
  isMergeDriverResolvable,
  loadConfig,
  TaskStore,
} from '@dispatch/core';
import type { CartoMode, GitReader } from '@dispatch/core';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json';
import {
  bearerToken,
  handleApi,
  isTrustedOrigin,
  mintDaemonTokens,
  rejectUnauthorized,
} from './api.js';
import type { ApiContext, DaemonTokens } from './api.js';
import { TaskCache } from './cache.js';
import { removeDaemonFile, writeDaemonFile } from './daemonfile.js';
import {
  createSourceChangeHandler,
  DepMapCache,
  depMapSourceDirs,
  isSkippedPath,
} from './depmap.js';
import { EventBus } from './events.js';
import { FindingStore } from './findings.js';
import { GitRepo } from './git/commands.js';
import { InboxStore } from './inbox.js';
import { LedgerStore } from './ledger.js';
import type { LinearClient } from './linear/client.js';
import { LinearSync } from './linear/sync.js';
import { NoteStore } from './notes.js';
import { EpicEngine } from './orchestrator/epic.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import { FixLoop, FixLoopStore } from './orchestrator/fixLoop.js';
import { JjManager } from './orchestrator/jj.js';
import { MergeQueue } from './orchestrator/mergeQueue.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { PlanManager } from './orchestrator/plan.js';
import { ClaudePlanner } from './orchestrator/planners/claude.js';
import type { CommandRunner } from './orchestrator/pr.js';
import { detectPrCapability, PrManager } from './orchestrator/pr.js';
import { QuestionRegistry } from './orchestrator/questions.js';
import { ReviewRunner } from './orchestrator/review.js';
import { ScopeRequestRegistry } from './orchestrator/scopeRequests.js';
import { VerificationRunner } from './orchestrator/verify.js';
import { ReviewCommentStore } from './reviewComments.js';
import { BoardSyncScheduler } from './sync/scheduler.js';
import { defaultGitRunner, SyncWorktree } from './sync/worktree.js';
import { watchSourceDirs, watchTasks } from './watcher.js';

export interface ServerHandle {
  port: number;
  // Minted at boot unless the caller supplied them. bin.ts prints `appToken`
  // on stdout; nothing else may log or persist either value.
  tokens: DaemonTokens;
  // Exposed for introspection/tests; its own 60s auto-refresh timer and
  // blocked-retry timer are started/stopped by startServer itself below.
  mergeQueue: MergeQueue;
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
  // Replaces credential lookup with a ready-made Linear client, so no sync test
  // ever reaches the network.
  linearClient?: LinearClient;
  // Fixed tokens instead of freshly minted ones, so a test can present a known
  // value. Production never passes this.
  tokens?: DaemonTokens;
  // Debounce for the board syncer's response to a local task-file change.
  // Defaults to BoardSyncScheduler's own multi-second default; tests pass
  // something much shorter.
  boardSyncDebounceMs?: number;
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

// The origin to echo back in `Access-Control-Allow-Origin`, or null when it is
// untrusted — a wildcard would let any page you visit read this daemon's tasks.
function resolveCorsOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  return isTrustedOrigin(origin) ? origin : null;
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
      'GET, POST, PATCH, DELETE, OPTIONS'
    );
    // `authorization` must stay listed: every guarded route needs the bearer
    // header, and the desktop webview and dev harness are both cross-origin to
    // this daemon, so dropping it makes the browser discard their requests at
    // the preflight before the daemon ever sees them.
    res.headers.set(
      'access-control-allow-headers',
      'content-type, authorization'
    );
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

/**
 * Serves `index.html` with the agent token inlined, because a browser page has
 * no filesystem and so cannot read the daemon file the CLI and MCP read.
 *
 * The token this hands out is the same request-tier one already sitting in
 * `~/.dispatch/daemons/<key>.json`, so a co-resident process learns nothing it
 * could not already read; the app token is never served. Cross-origin pages
 * cannot read this response either — static assets go through the same
 * `withCors` as everything else, and an untrusted origin gets no CORS header.
 */
async function serveIndexHtml(
  indexFile: ReturnType<typeof Bun.file>,
  agentToken: string
): Promise<Response> {
  const html = await indexFile.text();
  const inject = `<script>window.__DISPATCH_DAEMON_TOKEN__=${JSON.stringify(agentToken)}</script>`;
  return new Response(
    html.includes('</head>')
      ? html.replace('</head>', `${inject}</head>`)
      : `${inject}${html}`,
    {
      headers: {
        'content-type': CONTENT_TYPES['.html'],
        // A page carrying a credential must not sit in a shared cache.
        'cache-control': 'no-store',
      },
    }
  );
}

// Serves a built web UI out of `webDistDir`, falling back to `index.html` for
// any non-file path so client-side routes work on a hard refresh (a classic
// SPA fallback). Returns null if nothing in `webDistDir` matches, so the
// caller can fall through to a plain 404.
async function serveStatic(
  pathname: string,
  webDistDir: string,
  agentToken: string
): Promise<Response | null> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = Bun.file(join(webDistDir, relative));
  if (await candidate.exists()) {
    if (relative === 'index.html') {
      return await serveIndexHtml(candidate, agentToken);
    }
    const type = CONTENT_TYPES[extname(relative)];
    return new Response(
      candidate,
      type !== undefined ? { headers: { 'content-type': type } } : {}
    );
  }
  const indexFile = Bun.file(join(webDistDir, 'index.html'));
  if (await indexFile.exists()) {
    return await serveIndexHtml(indexFile, agentToken);
  }
  return null;
}

// ActorContext's GitReader seam: git/commands.ts has no single-value config
// reader, so this is a thin synchronous wrapper instead.
function makeGitReader(rootDir: string): GitReader {
  return (args) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: rootDir });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
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
  const tokens = opts.tokens ?? mintDaemonTokens();

  // Who this daemon acts as. Resolved first, before anything touches the
  // store, so a teammate is registered on the roster ahead of any task edit
  // this process might make.
  const actorContext = ActorContext.resolve(rootDir, makeGitReader(rootDir));

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

  // The board syncer: commits and pushes outstanding task files from a
  // private worktree, gated on config.yml's `autoCommit`. No trunk to pin to
  // (no origin/HEAD, no local main/master) means no syncer at all — logged
  // once here rather than left silent, but never fatal to boot.
  const syncWorktree = SyncWorktree.open(rootDir, defaultGitRunner);
  const boardSyncScheduler =
    syncWorktree === null
      ? null
      : new BoardSyncScheduler({
          rootDir,
          worktree: syncWorktree,
          actor: actorContext,
          run: defaultGitRunner,
          events,
          debounceMs: opts.boardSyncDebounceMs,
        });
  if (boardSyncScheduler === null) {
    console.log(
      `dispatchd: no trunk resolvable for ${rootDir}; board sync disabled`
    );
  }
  // Rides the same `task.changed` signal LinearSync's push debounce does —
  // the watcher above is one source of it, API mutation handlers are
  // another, so an edit made through either path reaches the board.
  const unsubscribeBoardSync = events.subscribe((event) => {
    if (event.type === 'task.changed') boardSyncScheduler?.notifyTaskChanged();
  });
  // The orchestrator's own executor registry: 'claude' (Slice O2's real
  // Agent SDK executor) is the production default per api.ts's createRun.
  // FakeExecutor is NOT registered by default (Phase 7) — bin.ts registers
  // it under 'fake' only when DISPATCH_ENABLE_FAKES=1, a test/e2e-only hook.
  // Tests override this default entirely via `registerExecutors` (see its
  // doc comment) to register a FakeExecutor without going through bin.ts at
  // all.
  // One jj manager shared by the orchestrator's stacked-dispatch path and the
  // merge queue's restack path, deliberately on the DEFAULT command runner
  // rather than `opts.prCommandRunner`. The gh/git fake behind
  // DISPATCH_FAKE_GH answers every unrecognized command `ok`, so a queue that
  // probed jj through that seam would decide a demo repo was jj-colocated and
  // take the jj rebase path against a repo with no jj at all.
  const jj = new JjManager(rootDir);
  // Shared with apiCtx below so a decision an agent records mid-run is
  // visible to buildTaskPrompt on the very next dispatch, no restart needed.
  const ledgerStore = new LedgerStore(rootDir);

  // The reverse-dependency map ReviewRunner scopes reviews with. Carto backs
  // it when available; the built-in scanner is the fallback. Source changes
  // re-sync carto's container before invalidating, so the next review reads a
  // current graph.
  // Boot must survive a malformed config.yml: this is the first loadConfig on
  // the startup path, and per-request loads still surface the real error.
  let cartoMode: CartoMode = 'on';
  try {
    cartoMode = loadConfig(rootDir).carto.enabled;
  } catch (err) {
    console.error(
      `dispatchd: could not read carto config, defaulting to 'on': ${(err as Error).message}`
    );
  }
  const depMapCache = new DepMapCache(rootDir, {
    mode: cartoMode,
    onDegrade: ({ detail }) => {
      ledgerStore.add({
        kind: 'hazard',
        title: 'dependency map degraded',
        detail: `carto unavailable, using the built-in scanner: ${detail}`,
        // Detected by the dep-map cache itself, not raised by a teammate.
        authoredBy: 'none',
      });
    },
  });
  const sourceWatcher = watchSourceDirs(
    depMapSourceDirs(rootDir),
    createSourceChangeHandler({
      rootDir,
      mode: cartoMode,
      cache: depMapCache,
    }),
    isSkippedPath
  );

  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events,
    jj,
    ledgerStore,
    actorContext,
  });
  if (opts.registerExecutors !== undefined) {
    opts.registerExecutors(orchestrator);
  } else {
    orchestrator.registerExecutor('claude', new ClaudeExecutor());
  }
  // Questions an agent raised mid-run. A run going terminal drops its own, so
  // the app never shows a card whose answer nobody is listening for.
  const questions = new QuestionRegistry();
  orchestrator.onRunTerminal((meta) => {
    if (questions.closeRun(meta.id) > 0) {
      events.broadcast({ type: 'question.closed', runId: meta.id });
    }
  });
  // Same lifecycle for out-of-scope edit requests: a run that ends still
  // holding one open should not leave it dangling for a human to find later.
  const scopeRequests = new ScopeRequestRegistry();
  orchestrator.onRunTerminal((meta) => {
    scopeRequests.closeRun(meta.id);
  });

  // Boot-time hygiene (spec §4): any run left non-terminal by a previous
  // crash is marked failed, and worktree directories with no matching
  // transcript at all are pruned.
  orchestrator.reconcileOnBoot();

  // Phase 5 P1, revised Phase 7: the planner registry (real ClaudePlanner
  // under 'claude' by default; tests/bin.ts's DISPATCH_ENABLE_FAKES override
  // via `registerPlanners`) and the epic dispatch engine, both wired against
  // the same store/cache/events/orchestrator every other request handler
  // shares.
  const planManager = new PlanManager({
    rootDir,
    store,
    cache,
    events,
    actorContext,
  });
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
    actorContext,
  });

  // Same one-time-at-boot treatment as prCapability below: whether the task
  // merge driver git config actually points at something resolvable on this
  // daemon's PATH. A missing binary never corrupts anything (git treats an
  // unrunnable driver as a genuine conflict), but it silently downgrades
  // every concurrent same-task edit from a field-level merge to a plain
  // line-based one — worth surfacing once at boot (see GET /api/sync) rather
  // than leaving it undiagnosable.
  const mergeDriverOk = isMergeDriverResolvable(rootDir);
  if (!mergeDriverOk) {
    console.log(
      `dispatchd: the task merge driver ('dispatch merge-task') is not resolvable on PATH for ${rootDir} — concurrent edits will fall back to line-based merging`
    );
  }

  // PR capability is detected once, here at boot, and never rechecked per
  // request — a project's gh/remote setup essentially never changes while
  // dispatchd is running, and re-shelling-out to `gh --version` on every
  // health check or review action would be wasted work.
  const prCapability = await detectPrCapability(rootDir, opts.prCommandRunner);
  const prManager = new PrManager(
    { rootDir, store, cache, events, orchestrator, actorContext },
    prCapability,
    opts.prCommandRunner
  );
  prManager.startPolling(opts.prPollIntervalMs);

  // Shares the exact same command-runner seam as PrManager (opts.prCommandRunner,
  // falling back to defaultCommandRunner) so DISPATCH_FAKE_GH=1 (or a test's
  // stub) fakes the merge queue's own gh/git calls too, not just PrManager's.
  const mergeQueue = new MergeQueue(
    { rootDir, store, cache, events, orchestrator, jj },
    opts.prCommandRunner
  );
  mergeQueue.startAutoRefresh();

  // The brain-dump inbox, scoped to this daemon's own actor, plus the one-time folds of older
  // storage shapes into it: the legacy single shared `inbox.md` (pre-dating per-actor files) and,
  // before that, the retired `notes.json` store. Both run at startup rather than behind a user
  // action because both are idempotent (see migrateLegacy/migrateNotes) and because a daemon that
  // has already read one should never serve an inbox that is missing it — a half-migrated state
  // is the one outcome worth ruling out entirely.
  const inboxStore = new InboxStore(rootDir, actorContext.member.handle);
  const migratedLegacy = inboxStore.migrateLegacy();
  if (migratedLegacy > 0) {
    console.log(
      `dispatchd: migrated ${migratedLegacy} item(s) from .dispatch/inbox.md into .dispatch/inbox/${actorContext.member.handle}.md`
    );
  }
  const migrated = inboxStore.migrateNotes(rootDir);
  if (migrated > 0) {
    console.log(
      `dispatchd: migrated ${migrated} note(s) from .dispatch/notes.json into .dispatch/inbox/${actorContext.member.handle}.md`
    );
  }

  // Bidirectional Linear sync. The poll timer only starts when the config enables it; the
  // debounced push rides the same `task.changed` signal the UI listens to.
  const linearSync = new LinearSync({
    rootDir,
    store,
    cache,
    events,
    client: opts.linearClient,
  });
  const unsubscribeLinear = events.subscribe((event) => {
    if (event.type === 'task.changed') linearSync.notifyTaskChanged();
  });
  linearSync.start();

  // Shares PrManager/MergeQueue's command-runner seam (opts.prCommandRunner).
  const gitRepo = new GitRepo(rootDir, opts.prCommandRunner);

  // Review dispatched as its own run kind. Built at boot because it subscribes
  // to the terminal hook that ingests a review's findings.
  const findingStore = new FindingStore(rootDir);
  const reviewRunner = new ReviewRunner({
    rootDir,
    store,
    findingStore,
    ledgerStore,
    depMap: depMapCache,
    events,
    orchestrator,
    actorContext,
  });

  // Verification as its own dispatched run kind, exercising finished work
  // rather than reading its diff.
  const verificationRunner = new VerificationRunner({
    rootDir,
    store,
    cache,
    events,
    orchestrator,
  });

  // Constructed after ReviewRunner on purpose: terminal hooks fire in
  // registration order, so a review's findings land before the loop reacts.
  const fixLoop = new FixLoop({
    rootDir,
    store,
    cache,
    events,
    orchestrator,
    reviewRunner,
    findingStore,
    fixLoopStore: new FixLoopStore(rootDir),
    actorContext,
  });
  // Runs after reconcileOnBoot has force-failed the previous process's runs,
  // so a loop waiting on one of them sees a terminal run and moves on.
  const resumedLoops = fixLoop.resumeOnBoot();
  if (resumedLoops > 0) {
    console.log(`dispatchd: resumed ${resumedLoops} stalled fix loop(s)`);
  }

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
    mergeQueue,
    prCapability,
    noteStore: new NoteStore(rootDir),
    inboxStore,
    findingStore,
    ledgerStore,
    reviewRunner,
    verificationRunner,
    fixLoop,
    reviewComments: new ReviewCommentStore(rootDir, actorContext.humanRef),
    questions,
    scopeRequests,
    linearSync,
    gitRepo,
    actorContext,
    tokens,
    boardSyncScheduler,
    mergeDriverOk,
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get('origin');

      if (url.pathname === '/ws') {
        // CORS never applies to a WebSocket, so without this an untrusted page
        // could upgrade and read the whole event stream. A null Origin is a
        // non-browser client, which the router's guard lets through too.
        if (origin !== null && !isTrustedOrigin(origin)) {
          return withCors(
            new Response('cross-origin websocket rejected', { status: 403 }),
            origin
          );
        }
        // The browser WebSocket API cannot set request headers, so this is the
        // one route that also takes the token as a query parameter.
        const wsToken = bearerToken(req) ?? url.searchParams.get('token');
        const unauthorized = rejectUnauthorized(
          req,
          tokens,
          'request',
          wsToken
        );
        if (unauthorized !== null) return withCors(unauthorized, origin);
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
        // Bun's 10s idle timeout is shorter than a model turn, so raise it for
        // every /api/ route rather than keeping a per-path list.
        srv.timeout(req, 65);
        return withCors(await handleApi(req, apiCtx), origin);
      }

      if (webDistDir !== null) {
        const staticResponse = await serveStatic(
          url.pathname,
          webDistDir,
          tokens.agentToken
        );
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
      agentToken: tokens.agentToken,
    });
  }

  return {
    port,
    tokens,
    mergeQueue,
    async stop() {
      watcher.close();
      sourceWatcher.close();
      prManager.stopPolling();
      mergeQueue.stop();
      unsubscribeLinear();
      await linearSync.stop();
      unsubscribeBoardSync();
      boardSyncScheduler?.stop();
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
