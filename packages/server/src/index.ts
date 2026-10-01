import {
  ActorContext,
  describeDroppedEntry,
  FileCommentStore,
  formatMigrationReport,
  generateSyncedRunId,
  generateSyncedTaskId,
  hasLegacyState,
  importLegacyProject,
  initProjectStores,
  isMergeDriverResolvable,
  loadConfig,
  MAX_HANDLE_BYTES,
  openProjectStores,
  SqliteTaskStore,
  syncSettings,
  TaskStore,
  totalImported,
} from '@dispatch/core';
import type {
  CartoMode,
  CommentStorePort,
  ExecutorCommand,
  GitReader,
  ProjectStores,
  SyncConfig,
  TaskStoreBackend,
  TaskStorePort,
} from '@dispatch/core';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json';
import type { A2ABridge } from './a2a/bridge.js';
import { openA2ABridge } from './a2a/bridge.js';
import type { WatchLimits } from './a2a/portRoutes.js';
import type { ListenerOverrides } from './a2a/settings.js';
import type { AiTaskFilterPort } from './aiTaskFilter.js';
import {
  bearerToken,
  createTaskChecked,
  handleApi,
  isTrustedOrigin,
  mintDaemonTokens,
  rejectUnauthorized,
  validateTaskInput,
} from './api.js';
import type { ApiContext, DaemonTokenPair, DaemonTokens } from './api.js';
import { spawnGitSync } from './blockingGit.js';
import { BrowserRegistry } from './browser/registry.js';
import { TaskCache } from './cache.js';
import { compressForNetwork } from './compression.js';
import { ConversationStore } from './conversations.js';
import {
  assertRootNotServed,
  removeDaemonFile,
  writeDaemonFile,
} from './daemonfile.js';
import { DecisionFeed } from './decisionFeed.js';
import {
  createSourceChangeHandler,
  DepMapCache,
  depMapSourceDirs,
  isSkippedPath,
} from './depmap.js';
import { docGateHandler, docGatePort } from './docs/gate.js';
import { DaemonDocsHost, docsMemoryPort } from './docs/host.js';
import { docsRestoreDir, openDocs } from './docs/open.js';
import { docsReceiptsStep } from './docs/receipts.js';
import { EventBus } from './events.js';
import type { SocketAudience } from './events.js';
import { FindingStore } from './findings.js';
import type { FindingStorePort } from './findings.js';
import { floorCheckForToolInput } from './floor.js';
import { GitRepo } from './git/commands.js';
import { resolvePushTarget } from './gitTarget.js';
import { sha256, TokenRegistry } from './identity.js';
import { IdleShutdown } from './idleShutdown.js';
import { InboxStore } from './inbox.js';
import type { InboxClusterer } from './inboxClusterer.js';
import { createJudgmentClient } from './judgments/client.js';
import type { JudgmentClient } from './judgments/client.js';
import {
  InboxTriageScheduler,
  InboxTriageSnapshotStore,
  judgedKindChanges,
  triageInbox,
} from './judgments/inboxTriage.js';
import { computeChecklist } from './judgments/landingChecklist.js';
import { DEP_MAP_DEGRADED_TITLE, LedgerStore } from './ledger.js';
import type { LedgerStorePort } from './ledger.js';
import type { LinearClient } from './linear/client.js';
import { LinearSync } from './linear/sync.js';
import { webhookUrlFor } from './linear/webhook.js';
import type { PreflightResult } from './memory/claudeModes.js';
import { docsOverflowPort } from './memory/overflow.js';
import { memoryReceiptsStep, memoryRestoreDir } from './memory/receipts.js';
import { openMemory, overseerMemory } from './memory/service.js';
import type { MemoryService } from './memory/service.js';
import {
  closeOrphanedGates,
  openHumanDecisions,
  SYSTEM_SENDER,
} from './messaging/gates.js';
import {
  createOverseerBus,
  ensureOverseerActor,
  overseerToolMessaging,
} from './messaging/overseerBus.js';
import type { Messaging } from './messaging/service.js';
import { openMessaging } from './messaging/service.js';
import { NoteStore } from './notes.js';
import { EpicEngine } from './orchestrator/epic.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import { CliExecutor } from './orchestrator/executors/cli.js';
import { availableCliPresets } from './orchestrator/executors/cliPresets.js';
import { CodexExecutor } from './orchestrator/executors/codex.js';
import { FixLoop, FixLoopStore } from './orchestrator/fixLoop.js';
import { JjManager } from './orchestrator/jj.js';
import { MergeQueue } from './orchestrator/mergeQueue.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { OverseerManager } from './orchestrator/overseer.js';
import { ClaudeOverseer } from './orchestrator/overseers/claude.js';
import { OverseerToolRegistry } from './orchestrator/overseerTools.js';
import { boardSyncDir, taskAuthorshipPath } from './orchestrator/paths.js';
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
import {
  generateRepoDigest,
  RepoDigestCache,
} from './orchestrator/repoDigest.js';
import { ReviewRunner } from './orchestrator/review.js';
import { TaskAuthorship } from './orchestrator/taskAuthorship.js';
import { runKind, TERMINAL_RUN_STATES } from './orchestrator/types.js';
import { VerificationRunner } from './orchestrator/verify.js';
import {
  policyActivityAppender,
  policyDecisionClassifier,
  PolicyEngine,
} from './policyEngine.js';
import type { ApprovalFloor } from './policyEngine.js';
import { PresenceTracker } from './presence.js';
import { PreviewSupervisor } from './preview.js';
import { PreviewGateway } from './previewGateway.js';
import {
  previewRequestHeaders,
  previewResponseHeaders,
  previewUpstreamUrl,
} from './previewHeaders.js';
import type { ReceiptsStep } from './receipts/exporter.js';
import { isReceiptEvent, ReceiptsScheduler } from './receipts/scheduler.js';
import { ReviewCommentStore } from './reviewComments.js';
import { sessionOrigins, sessionToken } from './session.js';
import type { SharedPageConfig } from './shared.js';
import { bindModeFor, isLoopbackAddress, ownOrigins } from './shared.js';
import { readProjectBackend, writeProjectBackend } from './storage.js';
import { BoardSyncScheduler } from './sync/scheduler.js';
import {
  defaultAsyncGitRunner,
  defaultGitRunner,
  SyncWorktree,
} from './sync/worktree.js';
import { SyncLedger } from './team/boardSync/ledger.js';
import { SyncRepo } from './team/boardSync/repo.js';
import { BoardSyncService } from './team/boardSync/service.js';
import { SyncedTaskStore } from './team/boardSync/syncedStore.js';
import type { Team } from './team/index.js';
import { createTeam, syncSeats } from './team/index.js';
import { TerminalRegistry } from './terminals.js';
import { TrackedFilesCache } from './trackedFiles.js';
import { EventLoopWatchdog } from './watchdog.js';
import { watchSourceDirs, watchTasks } from './watcher.js';
import { WebhookDelivery } from './webhookDelivery.js';

export interface ServerHandle {
  port: number;
  // The HTTPS listener teammates use, when `tls` was given.
  tlsPort?: number;
  // Minted at boot unless the caller supplied them. bin.ts prints `appToken`
  // on stdout; nothing else may log or persist either value.
  tokens: DaemonTokens;
  // Teammates' credentials and the license (team/). Exposed so a test can
  // issue a teammate a token without going through the API.
  team: Team;
  // Exposed for introspection/tests; its own 60s auto-refresh timer and
  // blocked-retry timer are started/stopped by startServer itself below.
  mergeQueue: MergeQueue;
  // Same reason as mergeQueue below it: reachable so a test can assert on the
  // orchestrator's own view of a project — in particular that its finding
  // store is the backend-selected one the API writes through, which is what
  // its blocked-finding merge gate reads.
  orchestrator: Orchestrator;
  // Exposed the same way, so a test can mint a run token or seed a message.
  messaging: Messaging;
  // The A2A bridge: its listener status, store and port.
  a2a: A2ABridge;
  // Exposed for introspection/tests — e.g. calling pollOnce() directly to
  // populate cachedPrs() deterministically instead of racing its internal
  // poll timer (started/stopped by startServer itself below).
  prManager: PrManager;
  // Task 7: exposed the same way prManager is — tests assert against real
  // git state (create/sync/removeIfClean/list) without going through HTTP.
  prWorktrees: PrWorktreeManager;
  // Exposed for tests, as mergeQueue is: they reach the memory store directly.
  memory: MemoryService;
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
  // Where to bind. `127.0.0.1` (the default) keeps the daemon to this machine;
  // `0.0.0.0` is team-local mode, reachable by teammates on the network. See
  // shared.ts for what changes between the two — the short version is that
  // nothing loopback made safe is assumed once it is not loopback.
  host?: string;
  // Extra origins teammates load the app from in team-local mode — a hostname
  // or a reverse proxy — beyond the interface addresses found automatically.
  publicOrigins?: string[];
  // Serve teammates over HTTPS. Needs `host: '0.0.0.0'`: TLS exists for the
  // network, and with it the plain listener drops back to 127.0.0.1, where
  // the CLI, MCP and the desktop sidecar reach it, so no token ever crosses
  // the network in the clear. `port` is the HTTPS listener's; 0 picks one.
  tls?: { certPath: string; keyPath: string; port?: number };
  // Tests pass false so parallel test runs don't fight over the one
  // per-rootDir daemon file.
  writeDaemonFile?: boolean;
  // Boot even when the daemon file names a live dispatchd for this root. Off
  // by default: a second daemon force-fails the first one's runs (see
  // assertRootNotServed). bin.ts sets it for `--replace` and `--init`.
  replaceRunningDaemon?: boolean;
  // Which backend this daemon's state lives in. Left unset it comes from
  // `DISPATCH_STORE_BACKEND` (see `resolveStoreBackend`), which defaults to
  // `sqlite` and imports any markdown board it finds on boot. Tests pass it
  // directly.
  storeBackend?: TaskStoreBackend;
  // Overrides which executors get registered on the orchestrator, in place
  // of the production defaults (ClaudeExecutor as 'claude', CodexExecutor as
  // 'codex' when the codex CLI is installed — Phase 7 moved FakeExecutor
  // behind bin.ts's DISPATCH_ENABLE_FAKES gate rather than always registering
  // it here). Tests that dispatch
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
  // The sentence-to-filter port behind POST /api/tasks/filter/ai, in place of
  // the production default (ClaudeAiTaskFilter built per request). bin.ts's
  // DISPATCH_ENABLE_FAKES gate passes FakeAiTaskFilter so a Playwright or dev
  // daemon never bills a model for a filter; route tests pass it directly.
  aiTaskFilter?: AiTaskFilterPort;
  // Same seam again for the overseer's chat backends, in place of the
  // production default (ClaudeOverseer as 'claude' only). Tests register a
  // FakeOverseer (see orchestrator/overseers/fake.ts) under 'claude' so no
  // endpoint test ever drives a real Agent SDK conversation.
  registerOverseers?: (overseerManager: OverseerManager) => void;
  // Overrides PrManager's gh/git seam and its capability-detection seam
  // (both take the same CommandRunner shape) so tests can exercise the PR
  // review path without a real GitHub remote or a logged-in gh CLI.
  prCommandRunner?: CommandRunner;
  // How often PrManager polls open PRs for a merged state. Defaults to the
  // plan's 60s; tests pass something much shorter.
  prPollIntervalMs?: number;
  // How long a run force-failed by reconcileOnBoot must sit with an unchanged
  // worktree before it is auto-resumed (see Orchestrator.autoResumeAfterBoot).
  // Defaults to the orchestrator's own 30s; a restart test passes milliseconds.
  autoResumeQuietMs?: number;
  // Replaces credential lookup with a ready-made Linear client, so no sync test
  // ever reaches the network.
  linearClient?: LinearClient;
  // Replaces TypeSafe key lookup with a ready-made judgment client (or null
  // to disable judgments outright), so no test ever reaches the API.
  judgments?: JudgmentClient | null;
  // Replaces the inbox clusterer with one built on a stub query function, so
  // a route test can see which items reach the model without a real session.
  inboxClusterer?: InboxClusterer;
  // Fixed tokens instead of freshly minted ones, so a test can present a known
  // value. Production never passes this.
  tokens?: DaemonTokenPair;
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
  // Debounce for the receipts exporter's response to a task change. Defaults
  // to ReceiptsScheduler's own multi-second default; tests pass something much
  // shorter. There is no periodic counterpart: the export has no remote to
  // fall out of sync with, so nothing changes without a `task.changed`.
  receiptsDebounceMs?: number;
  // How often the receipts exporter sweeps without an event. Defaults to
  // ReceiptsScheduler's own 5-minute default; tests pass something large
  // enough never to fire, since every startServer()-based test on the database
  // backend would otherwise boot a live interval.
  receiptsSweepMs?: number;
  // A main-thread heartbeat gap longer than this is logged as a stall, with
  // the section the daemon was in (see EventLoopWatchdog). Defaults to 5s.
  watchdogStallMs?: number;
  // Replaces the Claude export preflight (CLI version, env, managed settings),
  // so a test can choose export mode without a real Claude Code install.
  memoryPreflight?: () => Promise<PreflightResult>;
  // Exit on its own after this long with no requests, no connected client
  // and no live work (see IdleShutdown for the full rule). Unset means never:
  // only a daemon the CLI spawned in the background sets it, since a
  // `dispatch serve` in a terminal or an in-process test server has an owner
  // who stops it. `onIdle` is what "exit" means to the caller — bin.ts runs
  // its normal shutdown.
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  onIdle?: () => void;
  // One-boot A2A listener overrides from dispatchd's `--a2a-*` flags.
  a2a?: ListenerOverrides;
  // Standalone hosts' watch-stream limits; tests shorten the keepalive.
  a2aWatchLimits?: Partial<WatchLimits>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

// DISPATCH_WATCHDOG_STALL_MS overrides the watchdog's 5s default for every
// server this process starts. The test preload sets it high: an in-process
// test server shares its thread with the test's own synchronous fixture work
// (git init, worktree setup), which under load runs past 5s and would be
// reported as a daemon stall. Unset or unparsable means the default.
function watchdogStallMsFromEnv(): number | undefined {
  const raw = process.env.DISPATCH_WATCHDOG_STALL_MS;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const DEFAULT_WEB_DIST_DIR = join(moduleDir, '..', '..', 'web', 'dist');
// The desktop app's own browser build, for team-local mode (see bootServer).
const DESKTOP_DIST_DIR = join(
  moduleDir,
  '..',
  '..',
  '..',
  'apps',
  'desktop',
  'dist'
);

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
 * `DISPATCH_STORE_BACKEND` remains, but only for a project that has not
 * recorded a choice yet; once it has, the marker is the answer. No marker and
 * no variable means `sqlite`: the database is the default, and a project that
 * still has a markdown board is moved across by the one-time import in
 * `@dispatch/core`'s migrate.ts, which `startServer` runs before it serves
 * anything — the board is copied in one transaction, or the daemon refuses
 * to come up, so a boot never leaves a repo with two half-states. The marker
 * is written only after that import has committed.
 *
 * `DISPATCH_STORE_BACKEND=files` is the escape hatch for a project that must
 * stay on markdown (a shared checkout whose other clones cannot read the
 * database yet); it holds only until a marker is written.
 *
 * An unrecognized variable is a typo, not a third backend: log it and use
 * the default rather than failing boot over a misspelling.
 *
 * Exported so bin.ts's `--init` creates the same backend this will open — a
 * daemon that scaffolded files and then opened a database would find an empty
 * project and report nothing wrong.
 */
// Codex is offered only when its CLI is actually installed, so no picker ever
// lists an executor whose first run would die on spawn.
export function registerCodexIfInstalled(orchestrator: Orchestrator): void {
  if (Bun.which('codex') === null) return;
  orchestrator.registerExecutor('codex', new CodexExecutor());
}

/**
 * Registers every CLI-backed agent this project can dispatch on.
 *
 * Two sources, config winning: `executors.<name>.command` in config.yml is an
 * agent the user declared, and the presets cover well-known agents that are
 * already on PATH. A configured entry replaces the preset of the same name
 * outright rather than merging into it — a half-overridden argv would be
 * nobody's intent.
 *
 * `claude` and `codex` are skipped even if named, because both already have a
 * native executor that does strictly more (approvals, cost, resumable
 * sessions) and a CLI wrapper would silently replace it with less.
 */
export function registerCliExecutors(
  orchestrator: Orchestrator,
  rootDir: string
): void {
  // Boot must survive a malformed config.yml, the same way the carto and
  // prWorktreeDir reads below do: a config typo must cost the user their
  // declared agents, not their daemon. The presets still register, and a
  // per-request load still surfaces the real error.
  let configured: Record<string, { command?: ExecutorCommand }> = {};
  try {
    configured = loadConfig(rootDir).executors ?? {};
  } catch (err) {
    console.error(
      `dispatchd: could not read executor config, registering presets only: ${(err as Error).message}`
    );
  }
  const commands = { ...availableCliPresets() };
  for (const [name, entry] of Object.entries(configured)) {
    if (entry.command !== undefined) commands[name] = entry.command;
  }
  for (const [name, command] of Object.entries(commands)) {
    if (name === 'claude' || name === 'codex') continue;
    orchestrator.registerExecutor(name, new CliExecutor({ command }));
  }
}

/**
 * The sync settings this boot runs with, or null when sync is off. A config
 * that will not parse costs the daemon its sync, not its boot — the same rule
 * the executor and carto reads follow — and says so.
 */
function bootSyncSettings(rootDir: string): SyncConfig | null {
  try {
    const settings = syncSettings(loadConfig(rootDir));
    return settings.enabled ? settings : null;
  } catch (err) {
    console.error(
      `dispatchd: could not read sync settings, board sync is off: ${(err as Error).message}`
    );
    return null;
  }
}

export function resolveStoreBackend(rootDir: string): TaskStoreBackend {
  const recorded = readProjectBackend(rootDir);
  if (recorded !== null) return recorded;
  const raw = process.env.DISPATCH_STORE_BACKEND;
  if (raw === undefined || raw === '') return 'sqlite';
  if (raw === 'files') return raw;
  if (raw === 'sqlite') return raw;
  console.error(
    `dispatchd: unknown DISPATCH_STORE_BACKEND '${raw}', using 'sqlite'`
  );
  return 'sqlite';
}

// Brings `cache` up to date with `store` — just `ids` when the caller knows
// which tasks changed, the whole store when it does not — and returns the ids
// whose rows changed. Never lets that kill the daemon: a parse failure is
// logged when it first appears (and surfaced via `cache.problems()` at
// `GET /api/health`), and if the read throws outright — e.g. the tasks
// directory itself is unreadable for a moment — that's logged too and the
// last-good rows stay, since the cache only writes after a successful read.
// This runs both at boot and on every watcher-triggered change, which is
// exactly where the reviewer reproduced a crash: a bad file must degrade
// service, not end the process.
function safeSync(
  store: TaskStorePort,
  cache: TaskCache,
  ids: readonly string[] | null = null
): string[] {
  try {
    const known = new Set(cache.problems());
    const changed =
      ids === null ? cache.resync(store) : cache.refresh(store, ids);
    for (const problem of cache.problems()) {
      if (known.has(problem)) continue;
      console.error(`dispatchd: skipping unparsable task file ${problem}`);
    }
    return changed;
  } catch (err) {
    console.error(
      `dispatchd: cache rebuild failed, keeping last-good cache: ${(err as Error).message}`
    );
    return [];
  }
}

// The origin to echo back in `Access-Control-Allow-Origin`, or null when it is
// untrusted — a wildcard would let any page you visit read this daemon's tasks.
function resolveCorsOrigin(
  origin: string | null,
  own: ReadonlySet<string>
): string | null {
  if (origin === null) return null;
  return isTrustedOrigin(origin, own) ? origin : null;
}

// Adds CORS headers so the desktop webview / browser dev harness (a different
// origin than `http://127.0.0.1:<port>`) can read this daemon's responses,
// but ONLY for trusted origins (see resolveCorsOrigin). Mutating the existing
// response's headers keeps streamed bodies (Bun.file static responses) intact.
function withCors(
  res: Response,
  origin: string | null,
  own: ReadonlySet<string>
): Response {
  const allowed = resolveCorsOrigin(origin, own);
  if (allowed !== null) {
    res.headers.set('access-control-allow-origin', allowed);
    res.headers.set(
      'access-control-allow-methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    );
    // `authorization` must stay listed: every guarded route needs the bearer
    // header, and the desktop webview and dev harness are both cross-origin to
    // this daemon, so dropping it makes the browser discard their requests at
    // the preflight before the daemon ever sees them. The same holds for the
    // `idempotency-key` a message send carries.
    res.headers.set(
      'access-control-allow-headers',
      'content-type, authorization, idempotency-key'
    );
    // The allowed origin is request-dependent, so caches must key on it.
    // Appended: a gzipped reply already varies by accept-encoding.
    res.headers.append('vary', 'origin');
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
/**
 * What the served page is handed. On loopback, the agent token — a browser page
 * has no filesystem to read the daemon file from, and nothing but this machine
 * can load the page. In team-local mode, never a token: anyone on the network
 * can load this page, and injecting the operator's credential would hand it to
 * all of them. The page gets where it is and signs in with its own.
 */
type PageInjection =
  | { kind: 'token'; agentToken: string }
  | { kind: 'shared'; config: SharedPageConfig };

// `<` escaped so a root path containing `</script>` cannot close the tag.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function serveIndexHtml(
  indexFile: ReturnType<typeof Bun.file>,
  injection: PageInjection
): Promise<Response> {
  const html = await indexFile.text();
  const inject =
    injection.kind === 'token'
      ? `<script>window.__DISPATCH_DAEMON_TOKEN__=${scriptJson(injection.agentToken)}</script>`
      : `<script>window.__DISPATCH_SHARED__=${scriptJson(injection.config)}</script>`;
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

/** What each event socket carries: who opened it, and how to record them
 *  leaving. `handle` is null only for a socket whose credential resolved to
 *  nobody, which the upgrade guard already refuses — kept nullable so the
 *  type does not promise more than the guard does. */
interface SocketData extends SocketAudience {
  handle: string | null;
  release?: () => boolean;
}

// Constant-time, like principal.ts: /ws must tell the shared agent token
// apart from the owner's app token, since both resolve to the owner.
function isAgentToken(presented: string | null, agentToken: string): boolean {
  if (presented === null) return false;
  return timingSafeEqual(sha256(presented), sha256(agentToken));
}

// How often the idle sweep runs. Well under the shortest sensible
// idleTimeoutSec, so a swept preview is reclaimed promptly rather than up to
// a full interval late.
const PREVIEW_SWEEP_INTERVAL_MS = 30_000;

/**
 * Proxies `/preview/<runId>/...` to that run's dev server.
 *
 * The daemon-relative URL is the point: clients never learn the dev server's
 * own port, the supervisor sees every request (which is what keeps the idle
 * sweep honest), and a preview that has not started yet answers with a status
 * a UI can render instead of a connection error.
 *
 * SECURITY — the iframe embedding this MUST be sandboxed without
 * `allow-same-origin`. A preview serves code the agent just wrote, from this
 * daemon's own origin, and `serveIndexHtml` injects the agent token into the
 * HTML at `/`. Same-origin preview script could therefore fetch `/`, scrape
 * that token and drive the request tier of the API. An opaque-origin iframe
 * cannot, and `isTrustedOrigin` accepting every loopback port means CORS will
 * not save us here. The sandbox attribute in the app is load-bearing, not
 * cosmetic.
 */
async function proxyPreview(
  url: URL,
  req: Request,
  previews: PreviewSupervisor
): Promise<Response> {
  const [, , runId = '', ...rest] = url.pathname.split('/');
  const preview = previews.get(runId);
  if (preview === undefined) {
    return new Response('no preview for this run', { status: 404 });
  }
  if (preview.status !== 'ready') {
    // 503 rather than 404: the preview exists, it is just not up yet, and a
    // client polling this should keep polling.
    return new Response(`preview is ${preview.status}`, { status: 503 });
  }
  previews.touch(runId);

  const target = previewUpstreamUrl(
    preview.port,
    `/${rest.join('/')}`,
    url.search
  );
  if (target === null) {
    return new Response('not a preview path', { status: 400 });
  }
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: previewRequestHeaders(req.headers),
      body: req.body,
      redirect: 'manual',
      // A dev server streams; buffering here would break hot reload's
      // long-lived responses.
      ...{ duplex: 'half' },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: previewResponseHeaders(upstream.headers),
    });
  } catch {
    // The dev server died between the readiness probe and this request.
    return new Response('preview is not reachable', { status: 502 });
  }
}

// Serves a built web UI out of `webDistDir`, falling back to `index.html` for
// any non-file path so client-side routes work on a hard refresh (a classic
// SPA fallback). Returns null if nothing in `webDistDir` matches, so the
// caller can fall through to a plain 404.
async function serveStatic(
  pathname: string,
  webDistDir: string,
  injection: PageInjection
): Promise<Response | null> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = Bun.file(join(webDistDir, relative));
  if (await candidate.exists()) {
    if (relative === 'index.html') {
      return await serveIndexHtml(candidate, injection);
    }
    const type = CONTENT_TYPES[extname(relative)];
    return new Response(
      candidate,
      type !== undefined ? { headers: { 'content-type': type } } : {}
    );
  }
  const indexFile = Bun.file(join(webDistDir, 'index.html'));
  if (await indexFile.exists()) {
    return await serveIndexHtml(indexFile, injection);
  }
  return null;
}

// ActorContext's GitReader seam: git/commands.ts has no single-value config
// reader, so this is a thin synchronous wrapper instead.
function makeGitReader(rootDir: string): GitReader {
  return (args) => {
    const result = spawnGitSync(rootDir, args);
    return result.exitCode === 0 ? result.stdout.trim() : null;
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
 * The one-time import of a project's `.dispatch/` markdown and JSONL into the
 * database it is about to be served from, run on the boot that moves it.
 *
 * A failure here is fatal to boot, and deliberately so. The import is one
 * transaction, so a failure leaves the database empty and every source file
 * untouched — which means the project's real board is still the markdown on
 * disk. Coming up anyway would serve an empty board over it and invite writes
 * into a database nobody meant to use yet. Refusing to start leaves the
 * project exactly as it was, recoverable by unsetting DISPATCH_STORE_BACKEND.
 *
 * The report is printed in full rather than summarized to a count: it names
 * every source that did NOT move (fix-loop state, notes and inboxes are still
 * file-backed) and every record that could not be taken, and those are the
 * lines somebody has to act on.
 */
function migrateLegacyProjectOnBoot(
  rootDir: string,
  stores: ProjectStores
): boolean {
  if (!hasLegacyState(rootDir)) return true;
  // Deliberately NOT gated on the database already holding tasks.
  //
  // It used to be, and that made the import a strictly one-shot event keyed on
  // one record type. `.dispatch/findings.jsonl` and `ledger.jsonl` are
  // append-only files under git: a teammate's findings arrive on the next
  // `git pull`, landing in files beside a database that already has tasks in
  // it. The old guard saw a non-empty board and returned, so those records
  // were never imported and never would be — and a finding that never reaches
  // the database is invisible to the blocked-findings merge gate, which is a
  // silent correctness failure rather than a cosmetic one.
  //
  // Running it on every boot is safe because the import is idempotent by
  // construction: every insert is ON CONFLICT DO NOTHING against real ids, so
  // a pass with nothing new to do writes nothing. It is quiet, too — the
  // report is only printed when something actually moved or something went
  // wrong (below), so a steady-state boot logs nothing at all.
  let report;
  try {
    report = importLegacyProject(stores);
  } catch (err) {
    console.error(
      `dispatchd: refusing to start — the one-time import of ${rootDir} failed and nothing was written. ` +
        'Your task files, findings and ledger are untouched. ' +
        `Unset DISPATCH_STORE_BACKEND to go back to the file backend. Cause: ${(err as Error).message}`
    );
    throw err;
  }
  const moved = totalImported(report);
  if (moved > 0 || report.problems.length > 0) {
    console.log(
      `dispatchd: ${rootDir} still keeps state as files; imported ${moved} record(s) into the database before serving.`
    );
    console.log(formatMigrationReport(report));
  }
  // Whether it is safe to record this project as database-backed. Mirrors
  // `runMigrate`: a problem means some record exists ONLY in the markdown, and
  // the marker is what makes the CLI and the MCP tools stop reading those
  // files — so writing it here would strand exactly those records.
  return report.problems.length === 0;
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
  // Before touching any state: a root another live daemon is serving is not
  // ours to reconcile.
  if ((opts.writeDaemonFile ?? true) && opts.replaceRunningDaemon !== true) {
    await assertRootNotServed(opts.rootDir);
  }

  // Started before anything that can block, so a boot-time stall (a migration,
  // the run reconcile sweep) is named in the log like any other. A boot that
  // fails after this point must take the watchdog down with it: nothing else
  // holds a handle on it, and a leaked one keeps reporting stalls for a
  // server that never existed — in one process running many boots (the test
  // suite), those reports are false and drown the real ones.
  const watchdog = new EventLoopWatchdog({
    thresholdMs: opts.watchdogStallMs ?? watchdogStallMsFromEnv(),
  });
  watchdog.start();
  try {
    return await bootServer(opts, watchdog);
  } catch (err) {
    watchdog.stop();
    throw err;
  }
}

// Everything startServer does once its watchdog is armed; `handle.stop()`
// is what stops the watchdog on the success path.
async function bootServer(
  opts: StartServerOptions,
  watchdog: EventLoopWatchdog
): Promise<ServerHandle> {
  const { rootDir } = opts;

  const shouldWriteDaemonFile = opts.writeDaemonFile ?? true;
  const bindHost = opts.host ?? '127.0.0.1';
  const bindMode = bindModeFor(bindHost);
  if (!bindMode.ok) throw new Error(bindMode.error);
  const shared = bindMode.mode === 'shared';
  if (opts.tls !== undefined && !shared) {
    throw new Error(
      '--tls-cert and --tls-key serve teammates on the network, so they need --host 0.0.0.0'
    );
  }
  // With TLS, loopback keeps the plain listener and the network gets only the
  // encrypted one.
  const plainHost = opts.tls === undefined ? bindHost : '127.0.0.1';
  // Filled once the port is bound; empty in loopback mode, where nothing but
  // this machine's own origins is ever trusted.
  const ownOriginSet = new Set<string>();
  // Where a session cookie may come from: the above plus this daemon's own
  // loopback origin, exact port. Filled after bind too — see session.ts.
  const sessionOriginSet = new Set<string>();
  // Which bundle to serve. Team-local mode needs the desktop app's build: it
  // is the one with a sign-in screen, where the frozen @dispatch/web UI
  // expects an injected token that shared mode will never inject. With no
  // desktop build on disk, shared mode serves no UI at all rather than one
  // that cannot sign in — the API still answers the CLI and the MCP server.
  const webDistDir =
    opts.webDistDir !== undefined
      ? opts.webDistDir
      : shared
        ? existsSync(join(DESKTOP_DIST_DIR, 'index.html'))
          ? DESKTOP_DIST_DIR
          : null
        : DEFAULT_WEB_DIST_DIR;
  if (shared && webDistDir === null) {
    console.error(
      'dispatchd: team-local mode found no desktop build to serve — run `moonx desktop:build` or pass --web-dist <dir>'
    );
  }
  // One timestamp for both places that name this process: the daemon file
  // and GET /api/health.
  const startedAt = new Date().toISOString();

  // Who this daemon acts as. Resolved first, before anything touches the
  // store, so a teammate is registered on the roster ahead of any task edit
  // this process might make.
  const actorContext = ActorContext.resolve(rootDir, makeGitReader(rootDir));
  for (const entry of actorContext.droppedEntries) {
    const fix =
      entry.problem === 'too-long'
        ? `its handle is too long: shorten it to at most ${MAX_HANDLE_BYTES} bytes`
        : `it is malformed: fix it so it has an email and a handle of at most ${MAX_HANDLE_BYTES} bytes, made of lowercase letters, digits, '.', '_' and '-' and starting with a letter or digit`;
    console.warn(
      `team.yml: skipped ${describeDroppedEntry(entry)}: ${fix}; until it is fixed, dispatchd will not write team.yml or add any new teammate to it`
    );
  }

  // Credentials, once there is someone for them to speak for. The pair may be
  // supplied (a harness presetting the decide-tier token); the registry is
  // built from whichever pair is actually in use, so a preset token is
  // attributed rather than resolving to nobody.
  // Teammates' tokens and the license come from the team module (team/,
  // Elastic License 2.0); the registry asks it about any token that is not
  // one of the daemon's own two.
  const tokenPair = opts.tokens ?? mintDaemonTokens();
  const team = createTeam(rootDir, actorContext.member.handle);
  const tokens: DaemonTokens = {
    ...tokenPair,
    registry: new TokenRegistry(
      tokenPair,
      actorContext.member.handle,
      team.teammates
    ),
  };

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
  // Board sync (team/boardSync/) is read once, here: it decides how ids are minted
  // and which store everything below is handed, and both have to hold for the
  // life of the process. Turning it on or off takes a restart. Only the
  // database backend syncs this way — a file-backed board already travels in
  // the repo itself.
  const syncConfig = backend === 'sqlite' ? bootSyncSettings(rootDir) : null;
  const stores =
    backend === 'sqlite'
      ? initProjectStores({
          rootDir,
          backend,
          ...(syncConfig === null
            ? {}
            : { generateTaskId: generateSyncedTaskId }),
        })
      : openProjectStores({ rootDir, backend });
  // The first boot that lands this project on the database does two things,
  // in this order: import whatever markdown-and-JSONL state it still has, then
  // record the choice so every other process — the CLI, the MCP tools, the
  // next daemon started from a shell with no environment set — derives the
  // same answer from the project rather than from its own surroundings.
  //
  // The order is the point. The marker is what those processes read to find
  // the board, so writing it before the import had committed would aim them
  // at an empty database while the real board sat in markdown beside it.
  //
  // The import decides for itself whether there is anything to do (it checks
  // both for legacy files and for whether the database already holds the
  // board), so it is called on every sqlite boot rather than gated on the
  // marker out here. Gating on the marker is what let a cloned
  // `storage.json` with no database beside it skip the import entirely.
  //
  // Only `sqlite` is ever written: an absent marker already means `files`,
  // and writing one for every existing project would put a new file in repos
  // that never asked for it.
  if (backend === 'sqlite') {
    const safeToRecord = migrateLegacyProjectOnBoot(rootDir, stores);
    if (safeToRecord && readProjectBackend(rootDir) !== 'sqlite') {
      writeProjectBackend(rootDir, backend);
    } else if (!safeToRecord) {
      console.error(
        `dispatchd: NOT recording ${rootDir} as database-backed — some records above could not be imported and exist only in .dispatch/. ` +
          'Leaving the marker unset keeps them reachable through the files. Fix the records listed above and restart.'
      );
    }
  }
  // With sync on, everything gets the store that records each write as a
  // change for the other replicas; the board it writes to is the same one.
  let boardSync: BoardSyncService | null = null;
  const syncLedger =
    syncConfig === null
      ? null
      : new SyncLedger(
          join(boardSyncDir(rootDir), 'state.db'),
          // The person's Dispatch handle (git email → team.yml), the same one
          // every write is attributed to — not the OS login, which two
          // people on stock cloud machines share and one person can have
          // two of. The license counts sync seats by it.
          actorContext.member.handle
        );
  const syncedStore =
    syncLedger === null || !(stores.tasks instanceof SqliteTaskStore)
      ? null
      : new SyncedTaskStore(stores.tasks, syncLedger, () =>
          boardSync?.notifyLocalChange()
        );
  const store: TaskStorePort = syncedStore ?? stores.tasks;
  const cache = new TaskCache();
  const events = new EventBus();

  // Refresh + broadcast on any on-disk change, regardless of who made it:
  // the watcher names the tasks whose files changed, the cache re-reads just
  // those, and the broadcast names the ones whose content really differs. An
  // API write refreshes the cache itself before the watcher sees the file, so
  // its echo compares equal and costs no second `task.changed`. A change the
  // watcher cannot tie to a task falls back to a full resync. The cache's
  // first load comes after the watcher's first listing, so nothing between
  // them is missed.
  //
  // Only the file backend has a directory to watch, and only it needs one:
  // watching exists because a task file can change under a running daemon
  // (a git checkout, a hand edit, the board syncer). On the database backend
  // the daemon is the only writer by construction, so every change already
  // comes through an API handler that refreshes and broadcasts itself —
  // there is no third party to notice.
  const watcher =
    store instanceof TaskStore
      ? watchTasks(store.tasksDir, (ids) => {
          watchdog.mark('task watcher: cache refresh');
          const changed = safeSync(store, cache, ids);
          if (changed.length > 0) {
            events.broadcast({ type: 'task.changed', ids: changed });
          }
        })
      : null;
  safeSync(store, cache);
  // Serialized now, so the desktop's first request (every task, no bodies)
  // is answered from memory instead of built during a cold load.
  cache.queryMetaJson({ includeArchived: true });

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
          runAsync: defaultAsyncGitRunner,
          events,
          debounceMs: opts.boardSyncDebounceMs,
          periodicMs: opts.boardSyncPeriodicMs,
        });
  if (boardSyncScheduler === null && store instanceof TaskStore) {
    console.log(
      `dispatchd: no main branch for ${rootDir}; task files won't be committed`
    );
  }
  // Docs open before the boot receipt export and need nothing from messaging;
  // a docs.db this build cannot open leaves docs unavailable, never the daemon down.
  const docsHost = new DaemonDocsHost({
    store,
    events,
    rootDir,
    refreshTask: (taskId) => cache.refresh(store, [taskId]),
  });
  const docs = openDocs({
    rootDir,
    host: docsHost,
    ownerRef: actorContext.humanRef,
  });
  // The receipts exporter: the database backend's counterpart to the board
  // syncer above, and the other half of the split that comment describes. A
  // file-backed project's task files are already committed into the user's own
  // repo; a database-backed one has nothing in git at all until this writes it
  // out, so this is what keeps the project auditable.
  //
  // Unlike the board syncer it needs no trunk and no remote — the log is a
  // standalone repository under DISPATCH_HOME — so there is no "disabled
  // because nothing resolvable" case to log. Whether it runs at all is
  // config.yml's `receipts.enabled`, re-read on every pass rather than latched
  // here.
  // Memory opens further down; until it does, its step writes nothing.
  let memoryReceipts: ReceiptsStep | null = null;
  const receiptsScheduler =
    store instanceof TaskStore
      ? null
      : new ReceiptsScheduler({
          rootDir,
          stores,
          actor: actorContext,
          run: defaultAsyncGitRunner,
          events,
          debounceMs: opts.receiptsDebounceMs,
          sweepMs: opts.receiptsSweepMs,
          steps: [
            docsReceiptsStep(docs.service, docsRestoreDir(rootDir)),
            (dir) =>
              memoryReceipts?.(dir) ?? { changed: 0, removed: 0, problems: [] },
          ],
        });
  // Team doc changes that reach a sealed head (seals, reviews, status, links,
  // renames, deletes) export; open-revision amends and new heads wait for the seal.
  docsHost.onChange((c) => {
    if (c.scope === 'team' && c.kind !== 'amended' && c.kind !== 'revised')
      receiptsScheduler?.notifyChanged();
  });
  // One full export as the daemon comes up: it creates the log on a project
  // turning receipts on for the first time, and reconciles one left dirty by a
  // daemon that died mid-burst. In the background, in slices, so the server
  // answers while it runs. Never fatal — a project that cannot write its
  // receipt log still has a working board, and exportNow reports rather than
  // rejects.
  void receiptsScheduler?.exportNow();

  // Board sync, when on: publish the board as it stands (once, the first
  // time), then exchange changes with the other replicas on the remote. A
  // remote that cannot be resolved costs the daemon its sync, not its boot.
  if (syncConfig !== null && syncLedger !== null && syncedStore !== null) {
    // A repository of its own when the config names one, else a branch on
    // one of the project's own remotes.
    const remoteUrl = await resolvePushTarget(
      rootDir,
      syncConfig.repo === undefined
        ? { remote: syncConfig.remote }
        : { repo: syncConfig.repo },
      defaultAsyncGitRunner
    );
    if (remoteUrl === null) {
      console.error(
        `dispatchd: board sync is on but "${syncConfig.remote}" is not a remote of ${rootDir}; add it, or point sync.repo at a repository of its own. Sync is off until then.`
      );
    } else {
      boardSync = new BoardSyncService({
        store: syncedStore,
        ledger: syncLedger,
        repo: new SyncRepo(
          join(boardSyncDir(rootDir), 'repo'),
          remoteUrl,
          syncConfig.branch,
          syncLedger.replica,
          defaultAsyncGitRunner
        ),
        remote: remoteUrl,
        branch: syncConfig.branch,
        intervalMs: syncConfig.intervalSec * 1000,
        ...syncSeats(team),
        // A teammate's change lands like a local edit: the cache is resynced
        // and every client told which tasks moved, so boards refresh without
        // anyone reloading.
        onBoardChanged: () => {
          const changed = safeSync(store, cache);
          if (changed.length > 0) {
            events.broadcast({ type: 'task.changed', ids: changed });
          }
        },
      });
      const published = syncedStore.bootstrap();
      if (published > 0) {
        console.log(
          `dispatchd: board sync publishing ${published} existing tasks`
        );
      }
      boardSync.start();
      console.log(
        `dispatchd: board sync on as ${syncLedger.replica}, via ${syncConfig.branch} on ${remoteUrl}`
      );
    }
  }
  // Both ride the same `task.changed` signal LinearSync's push debounce does —
  // the watcher above is one source of it, API mutation handlers are
  // another, so an edit made through either path reaches the board and the
  // receipt log. Exactly one of the two schedulers is ever non-null, since
  // they are the file and database halves of the same job.
  const unsubscribeBoardSync = events.subscribe((event) => {
    if (event.type === 'task.changed') boardSyncScheduler?.notifyTaskChanged();
    // A wider net than the board syncer's: the receipt log carries findings and
    // ledger entries too, and those announce themselves on their own events.
    // Keyed on `task.changed` alone, a review raising twenty findings would put
    // nothing in the audit trail until an unrelated task edit came along.
    if (isReceiptEvent(event)) receiptsScheduler?.notifyChanged(event);
  });
  // The orchestrator's own executor registry: the real 'claude' backend, plus
  // 'codex' when its CLI is installed. A call that omits `executor` runs on
  // the project's `orchestrator.executor` (see Orchestrator.defaultExecutorName).
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
  // The audit ledger: the daemon's receipts, plus lesson rows memory imports.
  // Backed by the same store the tasks came from (the database's ledger table,
  // or `.dispatch/ledger.jsonl`); both satisfy `LedgerStorePort`.
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
  // Task comments: the database's table, or `.dispatch/comments/` on files.
  const commentStore: CommentStorePort =
    stores.records?.comments ?? new FileCommentStore(rootDir);

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
        title: DEP_MAP_DEGRADED_TITLE,
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
  // The TypeSafe judgment client, resolved once at boot: a key added later
  // needs a restart, same as the executors. Tests pass `judgments`
  // explicitly (null disables).
  const judgments =
    opts.judgments === undefined
      ? createJudgmentClient(rootDir)
      : opts.judgments;
  const orchestrator = new Orchestrator({
    rootDir,
    store,
    cache,
    judgments,
    events,
    jj,
    findingStore,
    comments: commentStore,
    // `null` on the file backend, where the run transcript is evidence's only
    // home. On sqlite this is what puts commands and mutations into the
    // database, which is what the receipts exporter materializes the git audit
    // trail from.
    evidenceStore: stores.records?.evidence ?? null,
    actorContext,
    digestCache,
    // Shares PrManager/MergeQueue/GitRepo's command-runner seam
    // (opts.prCommandRunner) for the PR-head-ref delete a retiring review does.
    commandRunner: opts.prCommandRunner,
    autoResumeQuietMs: opts.autoResumeQuietMs,
    // Docs' answer: the bridge's evidence once it has opened (see bindA2AOrigin).
    isA2ATask: (taskId) => docsHost.a2aOrigin(taskId),
  });
  orchestrator.setDocsPort(docs.service);
  // A publish task's run starts with the doc's recorded revision in its worktree.
  orchestrator.setWorktreeSeed((taskId, wt) =>
    docs.service.seedFor(taskId, wt)
  );
  // A teammate's synced change never moves a publishing task's risk.
  syncedStore?.setRiskGuard({
    publishing: (taskId) => docs.service.publishing(taskId),
    riskChanged: (taskId) => docs.service.riskChangedDuringPublish(taskId),
  });
  if (syncConfig !== null) orchestrator.setRunIdMinter(generateSyncedRunId);
  if (opts.registerExecutors !== undefined) {
    opts.registerExecutors(orchestrator);
  } else {
    orchestrator.registerExecutor('claude', new ClaudeExecutor());
    registerCodexIfInstalled(orchestrator);
    registerCliExecutors(orchestrator, rootDir);
  }
  // Messaging opens once the orchestrator exists (it mints run tokens and
  // hears onRunStarted); its recover() waits for reconcileOnBoot() below.
  const appendPolicyActivity = policyActivityAppender({ store, cache, events });
  const messaging = openMessaging({
    rootDir,
    orchestrator,
    store,
    events,
    ownerRef: actorContext.humanRef,
    ledgerStore,
    appendPolicyActivity,
  });
  // Memory opens before messaging.recover() because it registers the memory
  // gate's handler: an answer replayed with no handler is marked applied and lost.
  const memory = openMemory({
    rootDir,
    store,
    orchestrator,
    events,
    ledgerStore,
    messaging,
    ownerRef: actorContext.humanRef,
    appendPolicyActivity,
    watchLedgerFile:
      stores.records === null
        ? join(rootDir, '.dispatch', 'ledger.jsonl')
        : null,
    ...(opts.memoryPreflight === undefined
      ? {}
      : { preflight: opts.memoryPreflight }),
  });
  memoryReceipts = memoryReceiptsStep(
    () => memory.shared,
    memoryRestoreDir(rootDir)
  );
  docsHost.bindRuns(orchestrator);
  // A publish lands once its task does (on a merged run); task.changed is the signal.
  const syncDocPublishes = (): void => {
    try {
      docs.service.syncPublishes();
    } catch (err) {
      console.error('docs: recording publishes failed', err);
    }
  };
  syncDocPublishes();
  const unsubscribeDocPublishes = events.subscribe((event) => {
    if (event.type === 'task.changed') syncDocPublishes();
  });
  docsHost.bindMessaging(messaging.store);
  docsHost.bindMemory(docsMemoryPort(memory));
  // The doc gate's handler registers before messaging.recover(), even with
  // docs.db closed: an answer replayed with no handler would be lost.
  docsHost.bindGates(
    docGatePort({
      rootDir,
      engine: messaging.engine,
      ownerRef: actorContext.humanRef,
      issuedTier: (handle) => team.teammates.issuedTier(handle),
      ledgerStore,
      events,
      appendPolicyActivity,
      epicOf: (taskId) => store.get(taskId)?.meta.parent ?? null,
    })
  );
  messaging.gates.register('doc', docGateHandler(docs.service, docsHost));
  // Before messaging.recover() too: a replayed wake or dispatch starts runs,
  // and a run with no memory mode would load the host's native Claude memory.
  orchestrator.setMemoryPort(memory);
  // Before any run starts: the owner's runs stay in native mode until their
  // Claude notes are imported, once per project.
  // Before the first import, so long personal notes go straight to a doc.
  await memory.bindDocsOverflow(docsOverflowPort(docs.service));
  await memory.importClaudeOnce();
  // A coding run that finished cleanly gets its diff checked against the
  // task's requirements (see judgments/landingChecklist.ts). Fire-and-forget
  // off the terminal transition: the checklist is an annotation on the
  // landing row, so nothing waits on it, and a missing diff just means no
  // checklist.
  orchestrator.onRunTerminal((meta) => {
    if (meta.state !== 'finished' || runKind(meta) !== 'execute') return;
    if (judgments === null) return;
    const task = store.get(meta.taskId);
    if (task === null) return;
    let diff;
    try {
      diff = orchestrator.diff(meta.id);
    } catch {
      return;
    }
    void computeChecklist(judgments, rootDir, meta, task, diff).then(
      (checklist) => {
        if (checklist !== null) events.broadcast({ type: 'run.changed' });
      }
    );
  });

  // Boot-time hygiene (spec §4): any run left non-terminal by a previous
  // crash is marked failed, and worktree directories with no matching
  // transcript at all are pruned.
  orchestrator.reconcileOnBoot();
  // Only after reconcileOnBoot: run earlier, a replayed wake's new run would be
  // force-failed as an orphan. Still before HTTP serves or auto-resume fires.
  await messaging.recover();
  // Runs force-failed above left their gates open; nobody can act on them now.
  closeOrphanedGates(messaging.engine, orchestrator);
  // Open proposals a crash left without a gate get one; stray doc gates close.
  try {
    await docs.service.reconcileGates();
  } catch (err) {
    console.error('dispatchd: doc gate reconcile failed', err);
  }
  // Before HTTP serves: the boot import carries every ledger lesson in before
  // the first dispatch, then proposals a crash left without a gate get one.
  try {
    memory.importLedger();
  } catch (err) {
    console.error('dispatchd: boot ledger import failed', err);
  }
  // Team memory staged by `dispatch receipts restore` returns as proposals,
  // then the log is written again with memory in it.
  try {
    const restored = await memory.restoreStaged();
    for (const p of restored?.problems ?? [])
      console.error(`dispatchd: memory restore: ${p.file}: ${p.detail}`);
    if (restored !== null && restored.deferred > 0)
      console.error(
        `dispatchd: memory restore: ${restored.deferred} staged file(s) wait for the next boot`
      );
  } catch (err) {
    console.error('dispatchd: memory restore failed', err);
  }
  receiptsScheduler?.notifyChanged();
  try {
    await memory.recover();
  } catch (err) {
    console.error('dispatchd: memory gate recovery failed', err);
  }
  // After recovery, so the bridge reconciles against settled messaging state;
  // its listener opens only once the daemon's own ports are known (below).
  // PrManager is built further down; until it is, no PR counts as open.
  let prLookup: PrManager | null = null;
  const a2a = openA2ABridge({
    rootDir,
    messaging,
    tasks: store,
    validateTask: (input) => validateTaskInput(rootDir, { ...input }),
    // Validated by validateTask first, so a refusal here is a bug.
    createTask: (input) => {
      const created = createTaskChecked(
        { rootDir, store, cache, events },
        input
      );
      if (!created.ok) throw new Error(created.error);
      return created.doc;
    },
    updateTask: (id, patch) => {
      const doc = store.update(id, patch);
      cache.rebuild(store);
      events.broadcast({ type: 'task.changed' });
      return doc;
    },
    prOpen: (url) => prLookup?.cachedPrByUrl(url) !== undefined,
    orchestrator,
    events,
    ownerRef: actorContext.humanRef,
    version: packageJson.version,
    daemonPorts: () => [
      server.port ?? 0,
      ...(tlsServer === null ? [] : [tlsServer.port ?? 0]),
    ],
    ...(opts.a2a === undefined ? {} : { overrides: opts.a2a }),
    ...(opts.a2aWatchLimits === undefined
      ? {}
      : { watchLimits: opts.a2aWatchLimits }),
    ...(opts.tls === undefined
      ? {}
      : {
          teamTls: { certPath: opts.tls.certPath, keyPath: opts.tls.keyPath },
        }),
    mark: (label) => watchdog.mark(label),
    track: (fn) => (idle === null ? fn() : idle.track(fn)),
  });
  docsHost.bindA2AOrigin((taskId) => a2a.taskOrigin(taskId) === 'a2a');

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
  const taskAuthorship = new TaskAuthorship(taskAuthorshipPath(rootDir));
  const epicEngine = new EpicEngine({
    rootDir,
    store,
    cache,
    events,
    orchestrator,
    findingStore,
    actorContext,
    authorship: taskAuthorship,
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
  prLookup = prManager;

  // Hand-merged run branches (a git merge/squash done in a plain checkout,
  // outside review() and outside any PR) never get their reviewedAt set by
  // either of the two paths above, so they'd sit in the review queue as
  // "needs review" forever. Reconcile once at boot — catching anything merged
  // while dispatchd was down — and then on the PR poller's cadence.
  orchestrator.reconcileExternallyMergedRuns();
  const externalMergeTimer = setInterval(() => {
    watchdog.mark('reconcileExternallyMergedRuns tick');
    orchestrator.reconcileExternallyMergedRuns();
  }, opts.prPollIntervalMs ?? 60000);

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

  // The overseer chat assistant (see orchestrator/overseer.ts), assembled here
  // alongside PlanManager against the same shared peers. Its tool registry is
  // the confirmation gate: mutating tool calls queue as pending actions, and
  // only a human's answer to an action's overseer-action gate reaches a real
  // orchestrator/merge-queue mutation. `defaultExecutor` is left unset — the
  // registry's own fallback is the same 'claude' api.ts defaults to.
  const overseerAddress = actorContext.agentRef('overseer');
  ensureOverseerActor(
    messaging.store,
    overseerAddress,
    new Date().toISOString()
  );
  const overseerManager = new OverseerManager({
    rootDir,
    registry: new OverseerToolRegistry({
      store,
      cache,
      orchestrator,
      mergeQueue,
      openGates: () => openHumanDecisions(messaging.engine),
      ledgerStore,
      memory: overseerMemory(memory),
      messaging: overseerToolMessaging(messaging.engine),
      ownerRef: actorContext.humanRef,
      docs: docs.service,
    }),
    events,
    bus: createOverseerBus(messaging.engine, messaging.store, {
      owner: actorContext.humanRef,
      overseer: overseerAddress,
    }),
  });
  if (opts.registerOverseers !== undefined) {
    opts.registerOverseers(overseerManager);
  } else {
    overseerManager.registerBackend('claude', new ClaudeOverseer(rootDir));
  }
  messaging.bindOverseer(overseerManager);

  // The brain-dump inbox, scoped to this daemon's own actor, plus the one-time folds of older
  // storage shapes into it: the legacy single shared `inbox.md` (pre-dating per-actor files) and,
  // before that, the retired `notes.json` store. Both run at startup rather than behind a user
  // action because both are idempotent (see migrateLegacy/migrateNotes) and because a daemon that
  // has already read one should never serve an inbox that is missing it — a half-migrated state
  // is the one outcome worth ruling out entirely.
  const inboxStore = new InboxStore(rootDir, actorContext.member.handle);
  // The inbox's judgment pass, run in the background on every capture and
  // text edit (see judgments/inboxTriage.ts). Incremental: only items whose
  // text changed are sent, so a capture costs one call for that item. A
  // first-time reading also replaces the capture-time regex kind guess.
  const triageStore = new InboxTriageSnapshotStore(rootDir);
  const inboxTriage = new InboxTriageScheduler(async () => {
    if (judgments === null) return;
    const previous = triageStore.load();
    const next = await triageInbox(
      judgments,
      inboxStore.listAll(),
      cache.query(),
      previous
    );
    if (next === null) return;
    triageStore.save(next);
    for (const { id, kind } of judgedKindChanges(
      inboxStore.list(),
      previous,
      next
    )) {
      inboxStore.update(id, { kind });
    }
    events.broadcast({ type: 'inbox.changed' });
  });
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
    localHumanRef: actorContext.humanRef,
    comments: commentStore,
    webhookUrl: webhookUrlFor(opts.publicOrigins ?? []),
  });
  const unsubscribeLinear = events.subscribe((event) => {
    if (event.type === 'task.changed') linearSync.notifyTaskChanged();
    if (event.type === 'comment.changed') {
      linearSync.notifyCommentChanged(event.taskId, event.commentIds);
    }
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
  const fixLoopStore = new FixLoopStore(rootDir);
  const fixLoop = new FixLoop({
    rootDir,
    store,
    cache,
    events,
    orchestrator,
    reviewRunner,
    findingStore,
    fixLoopStore,
    actorContext,
  });
  // Runs after reconcileOnBoot has force-failed the previous process's runs,
  // so a loop waiting on one of them sees a terminal run and moves on.
  const resumedLoops = fixLoop.resumeOnBoot();
  if (resumedLoops > 0) {
    console.log(`dispatchd: resumed ${resumedLoops} stalled fix loop(s)`);
  }
  // The engine reads child phases off the loop; bound here because the loop
  // is constructed after it. Its own sessions re-arm on a delay (see
  // EpicEngine.resumeOnBoot) so the orchestrator's auto-resume goes first.
  epicEngine.bindFixLoop(fixLoop);
  const resumedEpics = epicEngine.resumeOnBoot();
  if (resumedEpics > 0) {
    console.log(`dispatchd: re-armed ${resumedEpics} epic dispatch session(s)`);
  }

  // One feed of everything awaiting a human, derived from the registries above
  // rather than stored (see decisionFeed.ts). `start()` subscribes it to the
  // event bus so a decided gate or a moved-on run broadcasts
  // `decisions.changed` without any producer having to know the feed exists.
  // The irreversibility floor's answer for the approval gate (floor.ts): a
  // force-push, a registry publish, a release-tag push or a repo-settings
  // change is never auto-allowed, at any rung. Any tool whose input carries a
  // shell command is covered, so the tool's name is not what decides.
  const approvalFloor: ApprovalFloor = (_toolName, input) =>
    floorCheckForToolInput(input) !== null;

  // Chromium instances the daemon drives. Nothing is launched at boot; this
  // only holds the ones a request asks for, so shutdown can kill them.
  const browsers = new BrowserRegistry();

  // Shell sessions, hydrated here so scrollback from a previous daemon is
  // readable the moment the app reconnects. Output is announced rather than
  // streamed: a client holds a byte cursor and pulls the increment, so a
  // dropped event costs a round trip and never a gap.
  const terminals = new TerminalRegistry(rootDir, {
    onOutput: (terminalId) =>
      events.broadcast({ type: 'terminal.output', terminalId }),
    onExit: (terminalId) =>
      events.broadcast({ type: 'terminal.exited', terminalId }),
  });

  const decisionFeed = new DecisionFeed({
    orchestrator,
    openGates: () => openHumanDecisions(messaging.engine),
    fixLoopStore,
    cache,
    events,
    conversationApprovalInput: (conversation, requestId) =>
      overseerManager
        .list()
        .find((record) => record.id === conversation)
        ?.pendingApprovals.find((a) => a.requestId === requestId)?.input,
    // The policy engine's classifier: a gate the project's rung auto-decides
    // shows up as `recorded` rather than `blocking`.
    policy: policyDecisionClassifier(rootDir, {
      riskOf: (taskId) => store.get(taskId)?.meta.risk,
      approvalFloor,
    }),
  });
  const stopDecisionFeed = decisionFeed.start();

  // Delivery beyond the app: each newly-blocking feed item POSTed to the
  // webhook in config.yml's `notifications:` block. Config is read per pass so
  // an edit applies live; the in-app record stays whatever the feed says.
  const webhookDelivery = new WebhookDelivery({
    rootDir,
    feed: decisionFeed,
    events,
    readConfig: () => loadConfig(rootDir).notifications,
  });
  const stopWebhookDelivery = webhookDelivery.start();

  // The gate hooks themselves — verify-retry and merge consult the project's
  // policy off the daemon's own signals; the scope gate consults it in
  // messaging/scopePolicy.ts. See policyEngine.ts.
  const policyEngine = new PolicyEngine({
    rootDir,
    store,
    events,
    orchestrator,
    fixLoop,
    verificationRunner,
    mergeQueue,
    ledgerStore,
    actorContext,
    approvalFloor,
    // The Activity half of each receipt; the ledger half is the engine's own.
    appendActivity: policyActivityAppender({ store, cache, events }),
    answerGate: async (messageId, answer) => {
      await messaging.engine.reply(messageId, answer, SYSTEM_SENDER);
    },
  });
  const stopPolicyEngine = policyEngine.start();

  // Who is connected right now — read off open event sockets, see presence.ts.
  const presenceTracker = new PresenceTracker();

  // Per-run dev-server previews. Config is read fresh per start (the same
  // shape the notifications reader above uses), so editing `preview:` in
  // config.yml takes effect without restarting the daemon.
  // Teammates' way into a preview (previewGateway.ts), in team-local mode
  // only. Declared before the supervisor so the supervisor's onStop can close
  // a gateway listener the moment its dev server goes.
  let previewGateway: PreviewGateway | null = null;
  const previews = new PreviewSupervisor({
    loadConfig: () => loadConfig(rootDir),
    onStop: (runId) => previewGateway?.close(runId),
  });
  const tlsFiles =
    opts.tls === undefined
      ? undefined
      : { cert: Bun.file(opts.tls.certPath), key: Bun.file(opts.tls.keyPath) };
  if (shared) {
    previewGateway = new PreviewGateway({
      previews,
      ...(tlsFiles === undefined ? {} : { tls: tlsFiles }),
    });
  }
  // Previews are swept on a timer rather than on each request: the sweep has
  // to reclaim a preview whose reviewer closed the tab and is therefore
  // making no requests at all, which a request-driven check never sees.
  const previewSweep = setInterval(() => {
    for (const runId of previews.sweepIdle()) {
      console.log(`dispatchd: swept idle preview for run ${runId}`);
    }
  }, PREVIEW_SWEEP_INTERVAL_MS);

  const apiCtx: ApiContext = {
    rootDir,
    store,
    judgments,
    inboxClusterer: opts.inboxClusterer,
    aiTaskFilter: opts.aiTaskFilter,
    cache,
    events,
    orchestrator,
    version: packageJson.version,
    planManager,
    overseerManager,
    epicEngine,
    taskAuthorship,
    messaging,
    docs: docs.service,
    memory,
    a2a,
    prManager,
    prWorktrees,
    mergeQueue,
    prCapability,
    startedAt,
    noteStore: new NoteStore(rootDir),
    inboxStore,
    inboxTriage,
    findingStore,
    ledgerStore,
    commentStore,
    reviewRunner,
    verificationRunner,
    fixLoop,
    depMapCache,
    trackedFilesCache,
    reviewComments,
    conversations,
    browsers,
    terminals,
    decisionFeed,
    linearSync,
    gitRepo,
    actorContext,
    tokens,
    boardSyncScheduler,
    receiptsScheduler,
    storeBackend: backend,
    mergeDriverOk,
    claimsDaemonFile: shouldWriteDaemonFile,
    watchdogStatus: () => watchdog.status(),
    previews,
    previewGateway,
    boardSync,
    team,
    presence: presenceTracker,
    ownOrigins: ownOriginSet,
    sessionOrigins: sessionOriginSet,
    shared,
  };

  const idle =
    opts.idleTimeoutMs !== undefined && opts.onIdle !== undefined
      ? new IdleShutdown({
          timeoutMs: opts.idleTimeoutMs,
          checkIntervalMs: opts.idleCheckIntervalMs,
          onIdle: opts.onIdle,
          // Everything that keeps working with no request in flight. Each is
          // something a restart would interrupt or lose (a live agent, a
          // queued merge, a shell), or a viewer that expects live events.
          isBusy: () =>
            events.hasClients() ||
            orchestrator
              .list()
              .some((r) => !TERMINAL_RUN_STATES.has(r.state)) ||
            mergeQueue.snapshot().entries.length > 0 ||
            epicEngine.hasActiveSession() ||
            fixLoop
              .list()
              .some(
                (l) => l.state === 'implementing' || l.state === 'reviewing'
              ) ||
            planManager.list().some((p) => p.state === 'running') ||
            planManager.listDrafts().some((d) => d.state === 'running') ||
            overseerManager.list().some((o) => o.state === 'running') ||
            terminals.list().some((t) => t.state === 'running') ||
            browsers.list().length > 0 ||
            // An exposed agent must stay up to answer.
            a2a.listening(),
        })
      : null;

  // Every listener serves the same routes off the same state; they differ
  // only in where they bind and whether they speak TLS. Returned as a function
  // so the HTTPS listener below is this, not a copy of it.
  const listen = (
    hostname: string,
    listenPort: number,
    tls?: {
      cert: ReturnType<typeof Bun.file>;
      key: ReturnType<typeof Bun.file>;
    }
  ) =>
    Bun.serve<SocketData>({
      port: listenPort,
      hostname,
      ...(tls === undefined ? {} : { tls }),
      async fetch(req, srv) {
        const url = new URL(req.url);
        const origin = req.headers.get('origin');
        // Named before any handler runs: a stall inside a synchronous handler
        // is then attributed to the request that caused it.
        watchdog.mark(`${req.method} ${url.pathname}`);

        if (url.pathname === '/ws') {
          // CORS never applies to a WebSocket, so without this an untrusted page
          // could upgrade and read the whole event stream. A null Origin is a
          // non-browser client, which the router's guard lets through too.
          if (origin !== null && !isTrustedOrigin(origin, ownOriginSet)) {
            return withCors(
              new Response('cross-origin websocket rejected', { status: 403 }),
              origin,
              ownOriginSet
            );
          }
          // The browser WebSocket API cannot set request headers, so this is the
          // one route that also takes the token as a query parameter. A
          // teammate's page has neither — its credential is the session cookie,
          // which the upgrade carries like any same-origin request.
          const wsToken =
            bearerToken(req) ??
            url.searchParams.get('token') ??
            sessionToken(req, sessionOriginSet);
          const unauthorized = rejectUnauthorized(
            req,
            tokens,
            'request',
            wsToken
          );
          if (unauthorized !== null)
            return withCors(unauthorized, origin, ownOriginSet);
          // Carry who connected onto the socket: presence is read off open
          // sockets, and the credential was just checked above, so resolving it
          // again cannot fail here. The tier and the agent-token flag scope
          // which sockets hear message events.
          const who = tokens.registry.resolve(wsToken);
          if (
            srv.upgrade(req, {
              data: {
                handle: who?.handle ?? null,
                ref: who?.ref ?? null,
                tier: who?.tier ?? null,
                agentToken: isAgentToken(wsToken, tokens.agentToken),
              },
            })
          ) {
            return undefined;
          }
          return withCors(
            new Response('expected websocket upgrade', { status: 400 }),
            origin,
            ownOriginSet
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
          return withCors(
            new Response(null, { status: 204 }),
            origin,
            ownOriginSet
          );
        }

        // Before /api/ and the static fallback: this is the one path whose
        // content belongs to someone else's server.
        if (url.pathname.startsWith('/preview/')) {
          // A preview has no credential of its own — an iframe cannot send one
          // on every sub-resource — so on loopback it is exactly as private as
          // the machine. In team-local mode that no longer holds, and a preview
          // of unmerged agent work is not something to serve the whole network
          // unauthenticated. Teammates review the diff and the share page; the
          // live preview stays on the machine running it.
          const peer = srv.requestIP(req)?.address ?? '';
          if (shared && !isLoopbackAddress(peer)) {
            return new Response(
              'previews are only served to the machine running the daemon',
              { status: 403 }
            );
          }
          return await proxyPreview(url, req, previews);
        }

        if (url.pathname.startsWith('/api/')) {
          // Bun's 10s idle timeout is shorter than a model turn, so raise it for
          // every /api/ route rather than keeping a per-path list.
          srv.timeout(req, 65);
          const response =
            idle === null
              ? await handleApi(req, apiCtx)
              : await idle.track(() => handleApi(req, apiCtx));
          return withCors(
            await compressForNetwork(
              req,
              response,
              srv.requestIP(req)?.address ?? null
            ),
            origin,
            ownOriginSet
          );
        }

        if (webDistDir !== null) {
          const staticResponse = await serveStatic(
            url.pathname,
            webDistDir,
            shared
              ? { kind: 'shared', config: { root: rootDir, baseUrl: '' } }
              : { kind: 'token', agentToken: tokens.agentToken }
          );
          if (staticResponse !== null)
            return withCors(staticResponse, origin, ownOriginSet);
        }

        return withCors(
          new Response('not found', { status: 404 }),
          origin,
          ownOriginSet
        );
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
          // Presence is announced before this socket joins the bus: everyone
          // else hears the arrival, and the newcomer does not get an event about
          // itself wedged in ahead of `hello` — it learns who is here by
          // fetching, like everything else it learns on connect.
          const { handle, ref } = ws.data;
          if (handle !== null && ref !== null) {
            const presence = presenceTracker.connect(handle, ref);
            ws.data.release = presence.release;
            if (presence.changed)
              events.broadcast({ type: 'presence.changed' });
          }
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
          if (ws.data.release?.() === true) {
            events.broadcast({ type: 'presence.changed' });
          }
        },
      },
    });

  const server = listen(plainHost, opts.port ?? 0);
  const tlsServer =
    opts.tls === undefined
      ? null
      : listen('0.0.0.0', opts.tls.port ?? 0, tlsFiles);

  // `Server.port` is typed optional (Bun also serves over unix sockets, which
  // have no port); we always bind a TCP hostname:port above, so it is always
  // defined in practice. Falling back to 0 keeps the types honest without an
  // assertion.
  const port = server.port ?? 0;
  const tlsPort = tlsServer === null ? undefined : (tlsServer.port ?? 0);
  await a2a.start();
  if (shared) {
    for (const origin of tlsPort === undefined
      ? ownOrigins(port, networkInterfaces(), opts.publicOrigins)
      : ownOrigins(tlsPort, networkInterfaces(), opts.publicOrigins, 'https')) {
      ownOriginSet.add(origin);
    }
    console.log(
      `dispatchd: team-local mode — teammates open ${[...ownOriginSet].join(' or ')} and sign in with a token from \`dispatch team invite\``
    );
  }
  for (const origin of sessionOrigins(port, ownOriginSet)) {
    sessionOriginSet.add(origin);
  }

  if (shouldWriteDaemonFile) {
    writeDaemonFile({
      rootDir,
      port,
      pid: process.pid,
      startedAt,
      agentToken: tokens.agentToken,
    });
  }

  return {
    port,
    ...(tlsPort === undefined ? {} : { tlsPort }),
    tokens,
    team,
    mergeQueue,
    orchestrator,
    messaging,
    a2a,
    prManager,
    prWorktrees,
    memory,
    async stop() {
      watchdog.stop();
      idle?.stop();
      clearInterval(previewSweep);
      previews.stopAll();
      // stopAll closes each preview's listener through onStop; this catches
      // one opened for a preview that stopped some other way.
      previewGateway?.closeAll();
      // First, so the boot recovery sweep stops before anything it might act
      // on is torn down — it can sit in a quiet window for minutes and ends by
      // starting an agent (see Orchestrator.shutdown).
      orchestrator.shutdown();
      epicEngine.shutdown();
      watcher?.close();
      sourceWatcher.close();
      prManager.stopPolling();
      clearInterval(externalMergeTimer);
      mergeQueue.stop();
      unsubscribeLinear();
      await linearSync.stop();
      unsubscribeBoardSync();
      unsubscribeDocPublishes();
      stopWebhookDelivery();
      stopDecisionFeed();
      stopPolicyEngine();
      // Kills every child and flushes scrollback; the sessions stay in the
      // index so the next daemon hydrates them as `orphaned`.
      terminals.shutdown();
      // Otherwise every session leaks a Chromium process.
      browsers.shutdown();
      boardSyncScheduler?.stop();
      // Before stores.close() below, since the exporter reads the database.
      await receiptsScheduler?.stop();
      // `server.stop(true)` force-closes every open connection, WebSockets
      // included — that fires our `websocket.close` handler for each client,
      // which removes it from `events` on the way out. See the note on
      // EventBus for why we don't also close each socket ourselves first.
      await server.stop(true);
      await tlsServer?.stop(true);
      await a2a.close();
      if (shouldWriteDaemonFile) removeDaemonFile(rootDir);
      // Last: the database handle outlives every reader above, and closing it
      // while a request is still in flight would fail that request rather
      // than let it finish. A no-op on the file backend.
      boardSync?.stop();
      syncLedger?.close();
      orchestrator.setMemoryPort(null);
      memory.close();
      messaging.close();
      orchestrator.setDocsPort(null);
      docs.stop();
      stores.close();
    },
  };
}

export type { ApiContext } from './api.js';
export { Orchestrator } from './orchestrator/orchestrator.js';
