import {
  ActorContext,
  DISPATCH_DIR,
  initProjectStores,
  isMergeDriverResolvable,
  loadConfig,
  openProjectStores,
  TaskStore,
} from '@dispatch/core';
import type {
  CartoMode,
  GitReader,
  TaskStoreBackend,
  TaskStorePort,
} from '@dispatch/core';
import { existsSync } from 'node:fs';
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
import { ConversationStore } from './conversations.js';
import { removeDaemonFile, writeDaemonFile } from './daemonfile.js';
import {
  createSourceChangeHandler,
  DepMapCache,
  depMapSourceDirs,
  isSkippedPath,
} from './depmap.js';
import { EventBus } from './events.js';
import { FindingStore } from './findings.js';
import type { FindingStorePort } from './findings.js';
import { GitRepo } from './git/commands.js';
import { InboxStore } from './inbox.js';
import { LedgerStore } from './ledger.js';
import type { LedgerStorePort } from './ledger.js';
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
import {
  defaultCommandRunner,
  detectPrCapability,
  PrManager,
} from './orchestrator/pr.js';
import { PrWorktreeManager } from './orchestrator/prWorktree.js';
import type { PrWorktreeManagerCtx } from './orchestrator/prWorktree.js';
import { QuestionRegistry } from './orchestrator/questions.js';
import {
  generateRepoDigest,
  RepoDigestCache,
} from './orchestrator/repoDigest.js';
import { ReviewRunner } from './orchestrator/review.js';
import { ScopeRequestRegistry } from './orchestrator/scopeRequests.js';
import { VerificationRunner } from './orchestrator/verify.js';
import { WardenManager } from './orchestrator/warden.js';
import { ClaudeWarden } from './orchestrator/wardens/claude.js';
import { WardenToolRegistry } from './orchestrator/wardenTools.js';
import { ReviewCommentStore } from './reviewComments.js';
import { readProjectBackend, writeProjectBackend } from './storage.js';
import { BoardSyncScheduler } from './sync/scheduler.js';
import { defaultGitRunner, SyncWorktree } from './sync/worktree.js';
import { TrackedFilesCache } from './trackedFiles.js';
import { watchSourceDirs, watchTasks } from './watcher.js';

export interface ServerHandle {
  port: number;
  // Minted at boot unless the caller supplied them. bin.ts prints `appToken`
  // on stdout; nothing else may log or persist either value.
  tokens: DaemonTokens;
  // Exposed for introspection/tests; its own 60s auto-refresh timer and
  // blocked-retry timer are started/stopped by startServer itself below.
  mergeQueue: MergeQueue;
  // Same reason as mergeQueue below it: reachable so a test can assert on the
  // orchestrator's own view of a project — in particular that its finding
  // store is the backend-selected one the API writes through, which is what
  // its blocked-finding merge gate reads.
  orchestrator: Orchestrator;
  // Exposed for introspection/tests — e.g. calling pollOnce() directly to
  // populate cachedPrs() deterministically instead of racing its internal
  // poll timer (started/stopped by startServer itself below).
  prManager: PrManager;
  // Task 7: exposed the same way prManager is — tests assert against real
  // git state (create/sync/removeIfClean/list) without going through HTTP.
  prWorktrees: PrWorktreeManager;
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
  // Which backend this daemon's state lives in. Left unset it comes from
  // `DISPATCH_STORE_BACKEND` (see `resolveStoreBackend`), which itself
  // defaults to `files` — so production behaviour is unchanged until a
  // project is deliberately moved. Tests pass it directly.
  storeBackend?: TaskStoreBackend;
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
  // Same seam again for the warden's chat backends, in place of the
  // production default (ClaudeWarden as 'claude' only). Tests register a
  // FakeWarden (see orchestrator/wardens/fake.ts) under 'claude' so no
  // endpoint test ever drives a real Agent SDK conversation.
  registerWardens?: (wardenManager: WardenManager) => void;
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
  // How often the board syncer polls even without a local edit. Defaults to
  // BoardSyncScheduler's own 60s default; tests pass something large enough
  // to never fire, since TaskStore.init() defaults new projects to
  // autoCommit: true and every startServer()-based test would otherwise boot
  // a live interval.
  boardSyncPeriodicMs?: number;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WEB_DIST_DIR = join(moduleDir, '..', '..', 'web', 'dist');

/**
 * Which store backend a project uses.
 *
 * The PROJECT's own recorded choice wins over anything in the environment.
 * That ordering is the whole point: the CLI and the MCP tools read the same
 * marker to decide whether they may touch the store directly, so a daemon
 * that took its answer only from `DISPATCH_STORE_BACKEND` could disagree with
 * them — an auto-started daemon inherits whatever shell spawned it, and one
 * without the variable would serve an empty `files` backend over a
 * database-backed project.
 *
 * `DISPATCH_STORE_BACKEND` remains, but only as the way to move a project
 * that has not recorded a choice yet; once it has, the marker is the answer.
 * No marker and no variable means `files`, which is every project today: the
 * one-time import that moves existing markdown and JSONL into a database has
 * not shipped yet (t-880ce2), so defaulting to `sqlite` would point every
 * existing project at an empty one.
 *
 * An unrecognized variable is a typo, not a third backend: log it and fall
 * back rather than failing boot over a misspelling.
 *
 * Exported so bin.ts's `--init` creates the same backend this will open — a
 * daemon that scaffolded files and then opened a database would find an empty
 * project and report nothing wrong.
 */
export function resolveStoreBackend(rootDir: string): TaskStoreBackend {
  const recorded = readProjectBackend(rootDir);
  if (recorded !== null) return recorded;
  const raw = process.env.DISPATCH_STORE_BACKEND;
  if (raw === undefined || raw === '') return 'files';
  if (raw === 'files') return raw;
  if (raw === 'sqlite') {
    // Refuse to open a fresh database beside a board that already has tasks
    // in it. Creating one here would leave the project with two half-states
    // — markdown nobody reads and an empty database everybody does — and
    // moving those tasks across is the import task's job, not a side effect
    // of an environment variable being set in the wrong shell.
    if (existsSync(join(rootDir, DISPATCH_DIR, 'tasks'))) {
      console.error(
        `dispatchd: DISPATCH_STORE_BACKEND=sqlite ignored for ${rootDir} — ` +
          'it already has a markdown task board, and moving it into a ' +
          'database is a migration, not a restart. Using files.'
      );
      return 'files';
    }
    return 'sqlite';
  }
  console.error(
    `dispatchd: unknown DISPATCH_STORE_BACKEND '${raw}', using 'files'`
  );
  return 'files';
}

// Rebuilds `cache` from `store`, and never lets a rebuild kill the daemon:
// per-file parse failures are logged once each (they're also surfaced via
// `cache.problems()` at `GET /api/health`), and if the rebuild throws outright
// — e.g. the tasks directory itself is unreadable for a moment — that's
// logged too and the previous (last-good) cache contents are simply left in
// place, since `TaskCache.rebuild` only mutates its table after a successful
// scan. This runs both at boot and on every watcher-triggered change, which
// is exactly where the reviewer reproduced a crash: a bad file must degrade
// service, not end the process.
function safeRebuild(store: TaskStorePort, cache: TaskCache): void {
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
 * A live `isMergeDriverResolvable` for `ApiContext.mergeDriverOk`.
 *
 * The setup this reports on is fixed out of band — the user runs `dispatch
 * init` in a terminal, as the warning tells them to — so nothing this daemon
 * observes marks the moment it starts being true. Captured at boot, a
 * successful `dispatch init` looked like it did nothing until a restart.
 *
 * Uncached: `GET /api/sync` is not polled (mount, `board.sync`, window focus),
 * so this is one `git config` per user-visible refresh — including the focus
 * refetch on switching back from that terminal.
 */
function makeMergeDriverCheck(rootDir: string): () => boolean {
  return () => isMergeDriverResolvable(rootDir);
}

/**
 * Wraps `new PrWorktreeManager` so a bad `prWorktreeDir` — its own
 * constructor refuses one that resolves inside `rootDir` (Task 7 review,
 * IMPORTANT 8) — degrades to the default worktree location instead of
 * crashing boot, the same "never let an optional setting take the daemon
 * down" posture as the guarded config reads elsewhere in this function.
 */
function buildPrWorktreeManager(ctx: PrWorktreeManagerCtx): PrWorktreeManager {
  try {
    return new PrWorktreeManager(ctx);
  } catch (err) {
    console.error(
      `dispatchd: invalid prWorktreeDir config, using the default worktree location: ${(err as Error).message}`
    );
    return new PrWorktreeManager({ ...ctx, prWorktreeDir: undefined });
  }
}

/**
 * Boots the dispatchd HTTP + WebSocket server for one dispatch project
 * (`rootDir`): a Bun.serve instance backed by an in-memory task cache that is
 * rebuilt from the project's store on boot, after every API mutation, and —
 * on the file backend — whenever the tasks directory changes on disk.
 *
 * This process is the project's single writer. It opens the store once, here,
 * and holds it until `stop()`; the CLI and the MCP tools reach the same state
 * through this daemon's HTTP API rather than opening a second handle on it.
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

  // The one handle on this project's state for the life of the daemon. Every
  // read and write below goes through `stores.tasks`, which is a
  // `TaskStorePort` — the daemon does not care whether that is the markdown
  // files under `.dispatch/tasks` or its own SQLite database, and nothing
  // downstream can tell.
  //
  // The two backends open differently on purpose. `files` only ATTACHES:
  // booting a daemon has never scaffolded `.dispatch/tasks`, and a project
  // with nothing there should read as uninitialized rather than as an empty
  // board. `sqlite` INITIALIZES, because there is no other process that
  // could have created the database — the daemon is the only one allowed to
  // open it, so "attach to the database someone else made" describes nobody.
  // Attaching there instead would boot a daemon whose every write fails with
  // "no dispatch database for <root>".
  const backend = opts.storeBackend ?? resolveStoreBackend(rootDir);
  const stores =
    backend === 'sqlite'
      ? initProjectStores({ rootDir, backend })
      : openProjectStores({ rootDir, backend });
  // Record the choice in the project the first time it lands on the database,
  // so every other process — the CLI, the MCP tools, the next daemon started
  // from a shell with no environment set — derives the same answer from the
  // project rather than from its own surroundings. Only `sqlite` is written:
  // an absent marker already means `files`, and writing one for every
  // existing project would put a new file in repos that never asked for it.
  if (backend === 'sqlite' && readProjectBackend(rootDir) === null) {
    writeProjectBackend(rootDir, backend);
  }
  const store = stores.tasks;
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
  //
  // Only the file backend has a directory to watch, and only it needs one:
  // watching exists because a task file can change under a running daemon
  // (a git checkout, a hand edit, the board syncer). On the database backend
  // the daemon is the only writer by construction, so every change already
  // comes through an API handler that rebuilds and broadcasts itself — there
  // is no third party to notice.
  const watcher =
    store instanceof TaskStore
      ? watchTasks(store.tasksDir, () => {
          safeRebuild(store, cache);
          events.broadcast({ type: 'task.changed' });
        })
      : null;

  // The board syncer: commits and pushes outstanding task files from a
  // private worktree, gated on config.yml's `autoCommit`. No trunk to pin to
  // (no origin/HEAD, no local main/master) means no syncer at all — logged
  // once here rather than left silent, but never fatal to boot.
  //
  // Also file-backend-only, and for a more basic reason than the watcher: it
  // copies task *files* into a git worktree and commits them. A
  // database-backed project has no such files; exporting its state to git is
  // the receipts exporter's job, not this one's.
  const syncWorktree =
    store instanceof TaskStore
      ? SyncWorktree.open(rootDir, defaultGitRunner)
      : null;
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
          periodicMs: opts.boardSyncPeriodicMs,
        });
  if (boardSyncScheduler === null && store instanceof TaskStore) {
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
  //
  // Backed by the same store the tasks came from: the database's ledger table
  // when this project has one, and `.dispatch/ledger.jsonl` otherwise. Both
  // satisfy `LedgerStorePort`, so nothing downstream branches on which.
  const ledgerStore: LedgerStorePort =
    stores.records?.ledger ?? new LedgerStore(rootDir);
  // Built here, above the Orchestrator, rather than beside ReviewRunner where
  // it is also used: Orchestrator.blockedFindingReason is the gate that stops
  // a run merging over an adjudicated `blocked` finding, and its context
  // falls back to `new FindingStore(rootDir)` when none is passed. Built
  // later, that fallback handed the orchestrator an empty JSONL store on a
  // database-backed project — the gate read no findings and every blocked
  // task merged. One instance, shared by everything that reads findings.
  const findingStore: FindingStorePort =
    stores.records?.findings ?? new FindingStore(rootDir);

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
  // Backs GET /api/impact's task-subject case; invalidated below off the
  // same signal as depMapCache rather than a TTL.
  const trackedFilesCache = new TrackedFilesCache(rootDir);
  const handleSourceChange = createSourceChangeHandler({
    rootDir,
    mode: cartoMode,
    cache: depMapCache,
  });
  const sourceWatcher = watchSourceDirs(
    depMapSourceDirs(rootDir),
    () => {
      // Shares depMapCache's watch, so its blind spot is the same one: a
      // tracked file added/removed outside depMapSourceDirs(rootDir) won't
      // invalidate this cache until some other change happens to fire it.
      trackedFilesCache.invalidate();
      handleSourceChange();
    },
    isSkippedPath
  );

  // The repo map injected into every run prompt. The real generator is wired in
  // only when this daemon is also running the real executor — `registerExecutors`
  // is the harness seam (tests and dev drivers supply a fake), and a bare
  // RepoDigestCache serves whatever is cached without ever calling a model.
  // Read per call so a config edit applies without restarting the daemon.
  const readDigestConfig = () => loadConfig(rootDir).repoDigest;
  const digestCache =
    opts.registerExecutors === undefined
      ? new RepoDigestCache(
          rootDir,
          (dir) => generateRepoDigest(dir),
          readDigestConfig
        )
      : new RepoDigestCache(rootDir);
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    events,
    jj,
    ledgerStore,
    findingStore,
    actorContext,
    digestCache,
    // Shares PrManager/MergeQueue/GitRepo's command-runner seam
    // (opts.prCommandRunner) for the PR-head-ref delete a retiring review does.
    commandRunner: opts.prCommandRunner,
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
  // line-based one — worth surfacing (see GET /api/sync) rather than leaving
  // it undiagnosable. Logged once here at boot; the API re-checks on a TTL so
  // the warning clears itself once the user fixes it.
  const mergeDriverOk = makeMergeDriverCheck(rootDir);
  if (!mergeDriverOk()) {
    console.log(
      `dispatchd: the task merge driver ('dispatch merge-task') is not resolvable on PATH for ${rootDir} — concurrent edits will fall back to line-based merging`
    );
  }

  // PR capability is detected once, here at boot, and never rechecked per
  // request — a project's gh/remote setup essentially never changes while
  // dispatchd is running, and re-shelling-out to `gh --version` on every
  // health check or review action would be wasted work.
  const prCapability = await detectPrCapability(rootDir, opts.prCommandRunner);
  // Built ahead of both PrManager (syncPrComments/pushPrReview read and
  // write a PR target's comments) and ReviewRunner below, which shares this
  // same instance — a review run's comments and a human's land in the same
  // per-target file rather than two stores fighting over one file.
  const reviewComments = new ReviewCommentStore(rootDir, actorContext.humanRef);
  // Task 7 review, IMPORTANT 7: guarded the same way carto's config is
  // above — a malformed config.yml on this, the boot path, must not take
  // the whole daemon down; a per-request loadConfig still surfaces the real
  // error to anything that reads config afterward.
  let prWorktreeDir: string | undefined;
  try {
    prWorktreeDir = loadConfig(rootDir).prWorktreeDir;
  } catch (err) {
    console.error(
      `dispatchd: could not read prWorktreeDir config, using the default worktree location: ${(err as Error).message}`
    );
  }
  // Task 7: cuts/syncs/retires PR review worktrees. Constructed ahead of
  // PrManager (whose context wires it in below) even though its own
  // `fetchHead` closure calls back into `prManager` — the same lazy-closure
  // trick `hasGithubHolds` uses for `mergeQueue` below: the closure only
  // reads `prManager` once a real sync actually runs, long after the `const`
  // it names has been assigned.
  const prWorktrees = buildPrWorktreeManager({
    rootDir,
    run: opts.prCommandRunner ?? defaultCommandRunner,
    prWorktreeDir,
    // confirmFork: true — a worktree only exists here because its PR already
    // passed the fork gate once (at creation); re-syncing it must not ask
    // again.
    fetchHead: async (n) => {
      await prManager.fetchPrHead(n, { confirmFork: true });
    },
  });
  // Annotated to break the prManager <-> mergeQueue closure inference cycle
  // (noImplicitAny under the sandbox project's stricter tsconfig).
  const prManager: PrManager = new PrManager(
    {
      rootDir,
      store,
      cache,
      events,
      orchestrator,
      actorContext,
      reviewComments,
      prWorktrees,
      // Lazy closure, not a direct reference: `mergeQueue` is constructed
      // below (it needs `prManager` itself for its own `prState` lookup), so
      // at this point in the function it exists only as a `const` binding
      // this closure will read once startPolling() actually calls it — long
      // after both constructors have run.
      hasGithubHolds: () =>
        mergeQueue
          .snapshot()
          .entries.some((entry) => entry.state === 'waiting-github'),
    },
    prCapability,
    opts.prCommandRunner
  );

  // Hand-merged run branches (a git merge/squash done in a plain checkout,
  // outside review() and outside any PR) never get their reviewedAt set by
  // either of the two paths above, so they'd sit in the review queue as
  // "needs review" forever. Reconcile once at boot — catching anything merged
  // while dispatchd was down — and then on the PR poller's cadence.
  orchestrator.reconcileExternallyMergedRuns();
  const externalMergeTimer = setInterval(
    () => orchestrator.reconcileExternallyMergedRuns(),
    opts.prPollIntervalMs ?? 60000
  );

  // Shares the exact same command-runner seam as PrManager (opts.prCommandRunner,
  // falling back to defaultCommandRunner) so DISPATCH_FAKE_GH=1 (or a test's
  // stub) fakes the merge queue's own gh/git calls too, not just PrManager's.
  const mergeQueue: MergeQueue = new MergeQueue(
    {
      rootDir,
      store,
      cache,
      events,
      orchestrator,
      jj,
      prState: (url) => prManager.cachedPrByUrl(url),
      cacheReady: () => prManager.cacheReady(),
    },
    opts.prCommandRunner
  );
  mergeQueue.startAutoRefresh();
  // Started only now, not right after PrManager's own construction above:
  // startPolling() calls `hasGithubHolds()` synchronously (to size its very
  // first tick's delay), and that closure reads `mergeQueue` — which does
  // not exist yet at the point PrManager is constructed.
  prManager.startPolling(opts.prPollIntervalMs);

  // The warden chat assistant (see orchestrator/warden.ts), assembled here
  // alongside PlanManager against the same shared peers. Its tool registry is
  // the confirmation gate: mutating tool calls queue as pending actions, and
  // only POST /api/warden/:id/actions/:actionId/confirm reaches a real
  // orchestrator/merge-queue mutation. `defaultExecutor` is left unset — the
  // registry's own fallback is the same 'claude' api.ts defaults to.
  const wardenManager = new WardenManager({
    rootDir,
    registry: new WardenToolRegistry({
      store,
      cache,
      orchestrator,
      mergeQueue,
      questions,
      ledgerStore,
    }),
    events,
  });
  if (opts.registerWardens !== undefined) {
    opts.registerWardens(wardenManager);
  } else {
    wardenManager.registerBackend('claude', new ClaudeWarden(rootDir));
  }

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
  // to the terminal hook that ingests a review's findings. `findingStore` is
  // the one built above, shared with the orchestrator's merge gate.
  // reviewComments is built above, alongside PrManager, which needs it too.
  // The working chat about code, separate from reviewComments — see ConversationStore's doc
  // comment for why the two aren't collapsed.
  const conversations = new ConversationStore(rootDir);
  const reviewRunner = new ReviewRunner({
    rootDir,
    store,
    findingStore,
    ledgerStore,
    depMap: depMapCache,
    events,
    orchestrator,
    actorContext,
    reviewComments,
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
    wardenManager,
    epicEngine,
    prManager,
    prWorktrees,
    mergeQueue,
    prCapability,
    noteStore: new NoteStore(rootDir),
    inboxStore,
    findingStore,
    ledgerStore,
    reviewRunner,
    verificationRunner,
    fixLoop,
    depMapCache,
    trackedFilesCache,
    reviewComments,
    conversations,
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
    orchestrator,
    prManager,
    prWorktrees,
    async stop() {
      watcher?.close();
      sourceWatcher.close();
      prManager.stopPolling();
      clearInterval(externalMergeTimer);
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
      // Last: the database handle outlives every reader above, and closing it
      // while a request is still in flight would fail that request rather
      // than let it finish. A no-op on the file backend.
      stores.close();
    },
  };
}

export type { ApiContext } from './api.js';
export { Orchestrator } from './orchestrator/orchestrator.js';
