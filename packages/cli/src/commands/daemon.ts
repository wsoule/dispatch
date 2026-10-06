import { childEnv } from '@dispatch-foo/core';
import type { Command } from 'commander';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { type CliContext, CliError } from '../context.js';
import { projectRoot } from '../projectRoot.js';
import { requireInitialized } from './task.js';

// ---------------------------------------------------------------------------
// Daemon-file discovery
//
// This mirrors the read side of packages/server/src/daemonfile.ts exactly:
// same hash scheme, same `$DISPATCH_HOME`/homedir fallback (including
// treating an empty string as unset), same on-disk layout. `@dispatch/cli`
// must stay Node-runnable, but `@dispatch/server` is Bun-only (bun:sqlite,
// Bun.serve), so the CLI can't import it directly — this is a small
// standalone copy of just the pieces `dispatch ui` needs to find a daemon
// someone else already started. Keep this block in sync with daemonfile.ts
// (plus three other copies of the same env-var-and-fallback scheme:
// apps/desktop/src-tauri/src/sidecar.rs's `daemon_home`, packages/mcp/src/
// daemon.ts's reader, and packages/server/src/orchestrator/paths.ts's
// `dispatchHome()` — that last one keys run/worktree state, not daemon
// files, but reads the identical env var) if it ever changes;
// test/daemon-cmd.test.ts cross-checks the hash against a fixture so drift
// fails loudly.
// ---------------------------------------------------------------------------

interface DaemonFileInfo {
  port: number;
  pid: number;
  rootDir: string;
  startedAt: string;
  // Request-tier credential. Optional here only so a file written by a daemon
  // that predates token auth still parses into an actionable error.
  agentToken?: string;
  // Written by a daemon started with --idle-timeout, i.e. by ensureDaemon
  // below, whose app token went to /dev/null; startedBy names the spawner.
  background?: boolean;
  startedBy?: string;
}

export function daemonHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

export function daemonFileKey(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export function daemonFilePath(rootDir: string): string {
  return join(
    daemonHome(),
    '.dispatch',
    'daemons',
    `${daemonFileKey(rootDir)}.json`
  );
}

function readDaemonFile(rootDir: string): DaemonFileInfo | null {
  const path = daemonFilePath(rootDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as DaemonFileInfo;
}

// ---------------------------------------------------------------------------
// dispatchd process management
// ---------------------------------------------------------------------------

// Locates the dispatchd entry point via Node's own module resolution rather
// than a hardcoded relative path, so it keeps working regardless of whether
// the CLI is run from source or from its built `dist/cli.js`. `@dispatch/
// server`'s `exports` map only exposes `./package.json` (it is Bun-only, so
// nothing else in it is safe to statically import from Node) — that single
// export exists specifically so this resolve() call has something to anchor
// on; the bin script sits alongside it at `src/bin.ts`, run directly by Bun
// (which executes TypeScript natively, no build step required).
//
// `@dispatch/server` is a devDependency only: the MIT-licensed CLI must not
// pull the FSL daemon into its published dependency tree, so this resolve
// succeeds in a monorepo checkout but not in a standalone install. There the
// daemon ships as a sibling `dispatchd` binary or via `DISPATCH_DAEMON_BIN`
// (see `resolveDaemonLauncher`), and this last-resort branch turns the raw
// module-not-found into an actionable error. `resolvePkg` is injectable only
// so tests can exercise that branch.
export function resolveDaemonBin(
  resolvePkg: (specifier: string) => string = (s) =>
    createRequire(import.meta.url).resolve(s)
): string {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = resolvePkg('@dispatch/server/package.json');
  } catch {
    throw new CliError(
      'no dispatchd found: this install has no bundled daemon and no ' +
        '@dispatch/server checkout. Install the Dispatch desktop app (which ' +
        'ships dispatchd), or set DISPATCH_DAEMON_BIN to a dispatchd binary ' +
        'or entry script.'
    );
  }
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

// How to launch dispatchd, resolved by `resolveDaemonLauncher`. `cmd` is the
// executable to spawn; `leadingArgs` are the args that must precede `--root`
// (the daemon entry script when launching through `bun`, empty when spawning a
// compiled binary directly); `env` carries extra vars merged into the child's
// environment (the sibling MCP binary path for a packaged install); `usesBun`
// tailors error messages, since the "is bun installed?" hint only makes sense
// on the bun-script path.
export interface DaemonLauncher {
  cmd: string;
  leadingArgs: string[];
  env?: Record<string, string>;
  usesBun: boolean;
}

/** The compiled sidecar filename used by a packaged CLI on this platform. */
export function bundledExecutableName(
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

// Classifies an explicit `DISPATCH_DAEMON_BIN` override: a `.ts`/`.js` entry
// still runs through `bun`, anything else is treated as a compiled binary
// spawned directly.
function launcherForOverride(binPath: string): DaemonLauncher {
  if (binPath.endsWith('.ts') || binPath.endsWith('.js')) {
    return { cmd: 'bun', leadingArgs: [binPath], usesBun: true };
  }
  return { cmd: binPath, leadingArgs: [], usesBun: false };
}

// Resolves how to launch dispatchd, in precedence order:
//   (a) `DISPATCH_DAEMON_BIN` — an explicit override (escape hatch for tests
//       and non-standard installs); see `launcherForOverride`.
//   (b) a compiled `dispatchd` binary sitting beside the running executable
//       (`process.execPath`'s directory). In a packaged Homebrew install the
//       compiled `dispatch` CLI, `dispatchd`, and `dispatch-mcp` all live
//       together in the app's Resources dir, so this is how the shipped CLI
//       finds the daemon without `bun` or the monorepo checkout — spawned
//       directly, and pointed at the sibling `dispatch-mcp` via
//       `DISPATCH_MCP_BIN` so the daemon's executor runs that compiled MCP
//       instead of shelling out to `bun` (see `buildDispatchMcpServerConfig`
//       in packages/server/src/orchestrator/executors/claude.ts). Mirrors the
//       desktop app's own `DaemonLaunch::Bundled` path in
//       apps/desktop/src-tauri/src/sidecar.rs.
//   (c) the monorepo source entry via `bun` (dev / running from a checkout) —
//       the original behavior, via `resolveDaemonBin`.
//
// `execPath` defaults to the running executable and is only injected by tests,
// which point it at a temp-dir layout to exercise the sibling-binary branch
// without depending on where the test runner itself lives.
export function resolveDaemonLauncher(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform
): DaemonLauncher {
  const override = process.env.DISPATCH_DAEMON_BIN;
  if (override !== undefined && override !== '') {
    return launcherForOverride(override);
  }

  const execDir = dirname(execPath);
  const siblingDaemon = join(
    execDir,
    bundledExecutableName('dispatchd', platform)
  );
  if (existsSync(siblingDaemon)) {
    const env: Record<string, string> = {};
    const siblingMcp = join(
      execDir,
      bundledExecutableName('dispatch-mcp', platform)
    );
    if (existsSync(siblingMcp)) env.DISPATCH_MCP_BIN = siblingMcp;
    return { cmd: siblingDaemon, leadingArgs: [], env, usesBun: false };
  }

  return { cmd: 'bun', leadingArgs: [resolveDaemonBin()], usesBun: true };
}

// Merges a launcher's extra env over the current process environment, or
// returns `undefined` (inherit as-is) when the launcher adds nothing — so the
// common bun-script path keeps its exact previous "no env override" behavior.
function childEnvFor(launcher: DaemonLauncher): NodeJS.ProcessEnv | undefined {
  if (launcher.env === undefined) return undefined;
  return { ...process.env, ...launcher.env };
}

// Default `openBrowser` used when a CliContext doesn't inject its own (tests
// inject a stub; real usage falls through to here).
function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [url], {
    stdio: 'ignore',
    detached: true,
    env: childEnv(),
  });
  // The daemon is already up by the time this runs — a host missing
  // `open`/`xdg-open` must not crash a bare `dispatch` invocation just
  // because it couldn't show the UI. Log and move on, same as
  // ensureDaemon's spawn error comment.
  child.on('error', (err) => {
    console.error(`dispatch: failed to open browser: ${err.message}`);
  });
  child.unref();
}

function openBrowserFor(ctx: CliContext, url: string): void {
  (ctx.openBrowser ?? defaultOpenBrowser)(url);
}

// Must match apps/desktop/src-tauri/tauri.conf.json's `productName` exactly —
// that's the name macOS's LaunchServices registry knows the app by, which is
// what `open -Ra <name>` and `open -a <name>` both key on.
const DESKTOP_PRODUCT_NAME = 'Dispatch';

// Default `openApp` used when a CliContext doesn't inject its own (tests
// inject a stub; real usage falls through to here). `--args --root <rootDir>`
// is passed through to the app the same way `bun bin.ts --root <rootDir>`
// would be, but a v1 limitation applies: an already-running desktop instance
// ignores launch args entirely, so this only actually seeds the root when no
// instance is running yet. The registry entry (written before this is
// called) is what makes the project show up in the switcher either way.
function defaultOpenApp(rootDir: string): void {
  const child = spawn(
    'open',
    ['-a', DESKTOP_PRODUCT_NAME, '--args', '--root', rootDir],
    { stdio: 'ignore', detached: true, env: childEnv() }
  );
  // Same rationale as defaultOpenBrowser's error handler: the daemon is
  // already up, so a spawn failure here (e.g. `open` missing on a non-macOS
  // host) is not fatal — just log it instead of letting it crash the CLI.
  child.on('error', (err) => {
    console.error(`dispatch: failed to open desktop app: ${err.message}`);
  });
  child.unref();
}

// Bare `dispatch`'s "show me the UI" step: prefer the installed desktop app
// over a browser tab when one is present. `open -Ra <name>` asks
// LaunchServices to resolve the app by name without launching it, exiting 0
// iff it's installed — so a non-zero exit (not installed) or any non-darwin
// platform falls back to the browser at the daemon's own URL. Both branches
// route through CliContext seams (`openApp`/`openBrowser`) so tests can
// assert on which path was taken without anything actually opening.
export function openDesktopOrBrowser(
  ctx: CliContext,
  port: number
): 'app' | 'browser' {
  if (process.platform === 'darwin') {
    const probe = spawnSync('open', ['-Ra', DESKTOP_PRODUCT_NAME], {
      env: childEnv(),
    });
    if (probe.status === 0) {
      (ctx.openApp ?? defaultOpenApp)(projectRoot(ctx.cwd));
      return 'app';
    }
  }
  openBrowserFor(ctx, `http://127.0.0.1:${port}`);
  return 'browser';
}

// A stale daemon file can name a port some OTHER process now holds — one that
// accepts the connection and then simply never answers. Without a deadline the
// probe inherits fetch's default (effectively none), so `dispatch task list`
// hangs indefinitely on a port that has nothing to do with dispatch. A health
// check is the one request that must never be the slow thing.
const HEALTH_TIMEOUT_MS = 2000;

// What one `/api/health` probe learned about a port. `unresponsive` is the
// case a plain boolean hid: something accepted the connection and stalled
// past the deadline. For the port a daemon file names, that is usually a live
// dispatchd too busy to answer — provisioning several run worktrees at once
// does it — not a dead one, and the two must not be treated alike (see
// locateDaemon).
type HealthProbe = 'healthy' | 'unresponsive' | 'down';

async function probeHealth(
  port: number,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<HealthProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? 'healthy' : 'down';
  } catch (err) {
    return (err as { name?: string }).name === 'TimeoutError'
      ? 'unresponsive'
      : 'down';
  }
}

async function isHealthy(port: number): Promise<boolean> {
  return (await probeHealth(port)) === 'healthy';
}

// Whether `pid` is a live process. Signal 0 sends nothing; EPERM means the
// process exists under another user, which still counts as alive.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

// How long to keep re-probing a daemon whose pid is alive but whose health
// check stalls, before giving up on it with an error.
const STALLED_DAEMON_WAIT_MS = 30_000;

export interface LocateDaemonOptions {
  // Per-probe deadline; tests shorten it.
  healthTimeoutMs?: number;
  // Total patience for a live-but-stalled daemon; tests shorten it.
  stalledWaitMs?: number;
}

// The daemon this project's daemon file names, or null when the file is
// absent or stale (nothing answers on its port, or its pid is gone). A live
// pid whose health check merely stalls is NEITHER: it is re-probed for up to
// `stalledWaitMs`, and if it never answers this throws instead of returning
// null. Null is what makes ensureDaemon spawn a replacement, and a
// replacement's boot reconcile force-fails every run the stalled daemon still
// has in flight — on 2026-09-07 three daemons stacked up on one root this
// way inside ten minutes, killing two waves of runs.
// Module-local: `findRunningDaemon` is the exported wrapper every caller uses,
// and `ensureDaemon` calls this directly.
async function locateDaemon(
  rootDir: string,
  opts: LocateDaemonOptions = {}
): Promise<DaemonConnection | null> {
  const info = readDaemonFile(rootDir);
  if (info === null) return null;
  const stalledWaitMs = opts.stalledWaitMs ?? STALLED_DAEMON_WAIT_MS;
  const deadline = Date.now() + stalledWaitMs;
  for (;;) {
    const probe = await probeHealth(info.port, opts.healthTimeoutMs);
    if (probe === 'healthy') return connectionFrom(info);
    if (probe === 'down' || !pidAlive(info.pid)) return null;
    if (Date.now() >= deadline) {
      throw new CliError(
        `dispatchd for this project (pid ${info.pid}, port ${info.port}) is running but has not answered a health check in ${Math.round(stalledWaitMs / 1000)}s — it is probably overloaded. Wait and retry, or stop it (kill ${info.pid}) before starting another; a second daemon would force-fail the runs it has in flight.`
      );
    }
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the daemon file + its `/api/health` for up to `timeoutMs`, for the
// case where `dispatch ui` just spawned a fresh daemon and needs to wait for
// it to finish booting (write its daemon file, bind its port, answer
// health checks) before it can hand a URL to the browser.
async function waitForHealthyDaemon(
  rootDir: string,
  timeoutMs: number
): Promise<DaemonFileInfo | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const info = readDaemonFile(rootDir);
    if (info !== null && (await isHealthy(info.port))) return info;
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

const STALE_DAEMON_MESSAGE =
  "this project's daemon file has no `agentToken`, so the dispatchd it " +
  'describes predates token auth — stop that daemon and start a new one.';

// The request-tier credential every CLI call to dispatchd presents. Failing
// here beats sending a doomed request the daemon can only answer with a 401.
function requireAgentToken(info: DaemonFileInfo): string {
  if (info.agentToken === undefined || info.agentToken === '') {
    throw new CliError(STALE_DAEMON_MESSAGE);
  }
  return info.agentToken;
}

/** A daemon this CLI can talk to: where it listens, the token to present,
 *  and who it is, for errors that have to name it. */
export interface DaemonConnection {
  port: number;
  agentToken: string;
  pid: number;
  // Started in the background by ensureDaemon, and by whom (daemon file).
  background: boolean;
  startedBy: string | null;
}

function connectionFrom(info: DaemonFileInfo): DaemonConnection {
  return {
    port: info.port,
    agentToken: requireAgentToken(info),
    pid: info.pid,
    background: info.background === true,
    startedBy: info.startedBy ?? null,
  };
}

// Attaches to an already-running daemon without ever starting one — the
// decide path needs this, because a daemon it started itself would have
// minted an app token nobody can present. `rootDir` may be any directory
// inside the project (a run's worktree, a subdirectory): the daemon is keyed
// by the project root it resolves to.
export async function findRunningDaemon(
  rootDir: string,
  opts: LocateDaemonOptions = {}
): Promise<DaemonConnection | null> {
  return locateDaemon(projectRoot(rootDir), opts);
}

export interface EnsureDaemonOptions extends LocateDaemonOptions {
  // Port to request when a fresh daemon must be spawned (default: ephemeral,
  // same as `dispatch serve`/`dispatch ui` with no `--port`).
  port?: string;
  // Who is spawning, written to the daemon file so a missing-app-token error
  // can name it (default: this dispatch process).
  startedBy?: string;
}

// ---------------------------------------------------------------------------
// Spawn claim
//
// Two `dispatch` invocations that both find no daemon used to both spawn one,
// then each decide after the fact which to keep — and because the daemon file
// is last-writer-wins, each could read it at a different instant, conclude the
// OTHER had won, and kill its own child. Both children die, both callers hold
// a dead port (CI, 2026-09-08: one caller got 40255, the other 36827). The
// server-side guard cannot close this either: a daemon writes its file only
// once its port is bound, so two daemons booting together both see no file.
//
// So the spawn decision is claimed before anything is spawned, with an
// O_EXCL create — the one filesystem operation that is atomic across
// processes. The winner spawns; every loser just waits for the winner's
// daemon and never spawns at all.
// ---------------------------------------------------------------------------

function spawnLockPath(rootDir: string): string {
  return `${daemonFilePath(rootDir)}.spawn.lock`;
}

// A lock whose owner died before releasing it would block every future spawn,
// so one this old is treated as abandoned and taken over. Comfortably longer
// than the 5s health wait a spawner holds it for.
const SPAWN_LOCK_STALE_MS = 30_000;

// Takes the spawn claim for `rootDir`, or returns false when another process
// holds it. A lock older than SPAWN_LOCK_STALE_MS is removed and re-attempted
// once — the only way a lock outlives its spawner is that spawner crashing.
function claimSpawn(rootDir: string): boolean {
  const path = spawnLockPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  for (const attempt of [0, 1]) {
    try {
      // 'wx' is O_CREAT | O_EXCL: it fails rather than truncating an existing
      // file, which is what makes this a claim and not just a write.
      closeSync(openSync(path, 'wx'));
      return true;
    } catch {
      if (attempt === 1) return false;
      try {
        if (Date.now() - statSync(path).mtimeMs < SPAWN_LOCK_STALE_MS) {
          return false;
        }
        rmSync(path);
      } catch {
        // Vanished between the two calls — the next attempt settles it.
      }
    }
  }
  return false;
}

function releaseSpawn(rootDir: string): void {
  try {
    rmSync(spawnLockPath(rootDir));
  } catch {
    // Already gone (a stale-lock takeover removed it); nothing to release.
  }
}

// How long a daemon this file spawns in the background may sit unused before
// it exits on its own (dispatchd's `--idle-timeout`). Nothing owns a detached
// daemon, so without a limit it ran until reboot — polling GitHub and, with
// the desktop app attached, fetching origin — long after the last command
// that needed it. Any request, connected client or live run resets the clock,
// and the next command that needs a daemon simply starts a fresh one.
const BACKGROUND_DAEMON_IDLE_TIMEOUT_S = 30 * 60;

// Shared "get me a healthy daemon for this project, starting one if none is
// running" logic — every command that needs to talk to dispatchd (`dispatch
// ui`, and every Phase 7 orchestrate/plan/epic command) goes through this
// exact same path: reuse an already-healthy daemon found via its daemon
// file, or spawn a fresh detached one and poll until it answers
// `/api/health`. Extracted from `dispatch ui`'s own action (which now just
// calls this and opens a browser at the result) so headless commands get
// identical auto-start behavior without duplicating it.
//
// Everything here is keyed on the resolved project root, never the raw cwd:
// a cwd inside a run's worktree (or a subdirectory of the checkout) must
// find — or spawn — the daemon for the project, not one rooted at the
// checkout it happens to be standing in.
export async function ensureDaemon(
  ctx: CliContext,
  opts: EnsureDaemonOptions = {}
): Promise<DaemonConnection> {
  const rootDir = projectRoot(ctx.cwd);
  const existing = await locateDaemon(rootDir, opts);
  if (existing !== null) return existing;

  // Someone else is already spawning for this root: wait for their daemon
  // rather than starting a second one. 20s covers a cold `bun` start on a
  // loaded machine and still leaves the stale-lock takeover as the backstop.
  if (!claimSpawn(rootDir)) {
    const winner = await waitForHealthyDaemon(rootDir, 20_000);
    if (winner !== null) return connectionFrom(winner);
    // The holder never produced a healthy daemon; fall through and spawn one
    // ourselves rather than failing because another process misbehaved.
  }

  const launcher = resolveDaemonLauncher();
  const args = [
    ...launcher.leadingArgs,
    '--root',
    rootDir,
    '--idle-timeout',
    String(BACKGROUND_DAEMON_IDLE_TIMEOUT_S),
    '--started-by',
    opts.startedBy ?? `dispatch (pid ${process.pid})`,
  ];
  if (opts.port !== undefined) args.push('--port', opts.port);

  // Detached + ignored stdio: this daemon should outlive the CLI invocation
  // that spawned it and keep running in the background, the same way
  // `dispatch serve` running in a separate terminal would. Its startup
  // `DISPATCH_APP_TOKEN=` line therefore goes to /dev/null and cannot be
  // recovered — deliberately, since `dispatch` runs inside agent shells whose
  // stdout the agent reads, and relaying that line there would hand the
  // decide-tier credential to the very caller the tier split excludes. Use
  // `dispatch serve` when you need an app token; `dispatch approve`, `message`
  // and `scope` say so when they have none.
  //
  // On the bun-script
  // path no `env` override is passed, so the child inherits this process's
  // full environment — including `DISPATCH_ENABLE_FAKES`/`DISPATCH_HOME` when
  // a test (or a user) has set them, which is what lets the CLI's own e2e
  // tests exercise this exact auto-start path against a fakes-enabled daemon.
  // The compiled-sibling path adds `DISPATCH_MCP_BIN` on top of that same
  // inherited environment (see `resolveDaemonLauncher`).
  const child = spawn(launcher.cmd, args, {
    detached: true,
    stdio: 'ignore',
    env: childEnvFor(launcher),
  });
  child.on('error', () => {
    // Surfaced below via the health-poll timeout instead of here — by the
    // time this fires asynchronously, the caller may already have moved on
    // to polling, so there's nothing safe to throw into.
  });
  child.unref();

  try {
    const info = await waitForHealthyDaemon(rootDir, 5000);
    if (info === null) {
      throw new CliError(
        launcher.usesBun
          ? 'dispatchd did not become healthy within 5s (is bun installed? https://bun.sh)'
          : `dispatchd did not become healthy within 5s (launched ${launcher.cmd})`
      );
    }
    // Kept as a backstop for the one case the claim cannot cover: a daemon
    // someone started outside this code path (a bare `dispatch serve`) landing
    // between our claim and our child's own daemon-file write.
    const winner = await resolveRaceWinner(rootDir, child, info);
    return connectionFrom(winner);
  } finally {
    // Only once the daemon is up (or has failed): releasing earlier would let
    // a waiting caller through while there is still nothing to find.
    releaseSpawn(rootDir);
  }
}

// I3: two concurrent `ensureDaemon` calls for the same rootDir (e.g. two
// separate `dispatch` invocations racing each other with no daemon running
// yet) can each see "no daemon file" and each spawn their own dispatchd —
// both eventually call `writeDaemonFile` for the exact same path, so only
// the LAST write survives, but the FIRST writer's process keeps running
// regardless: a leaked dispatchd nobody will ever talk to again. Once our
// own spawn is confirmed healthy, re-read the daemon file one more time —
// if it now names a different (and itself healthy) pid, that other
// dispatchd is the race's actual winner; kill the one we spawned rather
// than leak it, and defer to the winner's port.
//
// SIGKILL, not SIGTERM: bin.ts's graceful-shutdown path calls
// `removeDaemonFile`, which deletes whatever is CURRENTLY at that path —
// if the loser's own shutdown ran after the winner had already overwritten
// the file with its own info, a graceful kill would delete the WINNER's
// still-valid daemon file. SIGKILL bypasses that handler entirely, so the
// file (already showing the winner) is left untouched.
async function resolveRaceWinner(
  rootDir: string,
  spawnedChild: ChildProcess,
  fallback: DaemonFileInfo
): Promise<DaemonFileInfo> {
  const info = readDaemonFile(rootDir);
  if (
    info !== null &&
    spawnedChild.pid !== undefined &&
    info.pid !== spawnedChild.pid &&
    (await isHealthy(info.port))
  ) {
    try {
      process.kill(spawnedChild.pid, 'SIGKILL');
    } catch {
      // Already gone, or never actually started — nothing more to clean up.
    }
    return info;
  }
  return fallback;
}

export interface ServeOptions {
  port?: string;
  host?: string;
  publicOrigin?: string;
  webDist?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsPort?: string;
  a2aHost?: string;
  a2aPort?: string;
  a2aPublicUrl?: string;
  a2aTlsCert?: string;
  a2aTlsKey?: string;
  replace?: boolean;
}

// The dispatchd arguments `dispatch serve` passes, in a stable order; throws
// when a certificate comes without its key or a key without its certificate.
export function serveArgs(root: string, o: ServeOptions): string[] {
  if ((o.tlsCert === undefined) !== (o.tlsKey === undefined)) {
    throw new CliError('--tls-cert and --tls-key go together');
  }
  if ((o.a2aTlsCert === undefined) !== (o.a2aTlsKey === undefined)) {
    throw new CliError('--a2a-tls-cert and --a2a-tls-key go together');
  }
  const flags: [string, string | undefined][] = [
    ['--port', o.port],
    ['--host', o.host],
    ['--public-origin', o.publicOrigin],
    ['--web-dist', o.webDist],
    ['--tls-cert', o.tlsCert],
    ['--tls-key', o.tlsKey],
    ['--tls-port', o.tlsPort],
    ['--a2a-host', o.a2aHost],
    ['--a2a-port', o.a2aPort],
    ['--a2a-public-url', o.a2aPublicUrl],
    ['--a2a-tls-cert', o.a2aTlsCert],
    ['--a2a-tls-key', o.a2aTlsKey],
  ];
  const args = ['--root', root];
  for (const [flag, value] of flags) {
    if (value !== undefined) args.push(flag, value);
  }
  return args;
}

// How long `dispatch serve` waits on a spawn claim another process holds, and
// on a daemon it asked to exit.
const SERVE_CLAIM_WAIT_MS = 25_000;
const HANDOVER_EXIT_WAIT_MS = 30_000;

// `dispatch serve`: takes the project over from a background daemon (or, with
// --replace, any daemon) by asking it to exit once nothing is live, then runs
// dispatchd in the foreground. The spawn claim is held from before the old
// daemon exits until the new one has written its daemon file, so an MCP call
// in that gap waits for this daemon instead of spawning another.
async function serveInForeground(
  ctx: CliContext,
  root: string,
  opts: ServeOptions
): Promise<number> {
  const launcher = resolveDaemonLauncher();
  const args = [...launcher.leadingArgs, ...serveArgs(root, opts)];
  const deadline = Date.now() + SERVE_CLAIM_WAIT_MS;
  while (!claimSpawn(root)) {
    if (Date.now() >= deadline)
      throw new CliError(
        'another dispatch process is starting a daemon for this project; try again in a moment'
      );
    await sleep(200);
  }
  let claimed = true;
  const release = () => {
    if (claimed) releaseSpawn(root);
    claimed = false;
  };
  try {
    await stopForTakeover(ctx, root, opts.replace === true);
    const child = spawn(launcher.cmd, args, {
      stdio: 'inherit',
      env: childEnvFor(launcher),
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', (err) => {
        reject(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new CliError(
                launcher.usesBun
                  ? 'dispatch serve requires bun (https://bun.sh)'
                  : `dispatch serve could not launch the daemon binary: ${launcher.cmd}`
              )
            : err
        );
      });
      child.on('exit', (code, signal) => {
        resolve(code ?? (signal === null ? 0 : 1));
      });
    });
    // Ctrl+C reaches dispatchd through the terminal; a kill of this process
    // is passed on, and either way this waits for it to shut down.
    const ignore = () => {};
    const forward = () => child.kill('SIGTERM');
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forward);
    try {
      const booted = waitForDaemonPid(root, child.pid, 20_000);
      await Promise.race([booted, exited.catch(() => undefined)]);
      release();
      return await exited;
    } finally {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', forward);
    }
  } finally {
    release();
  }
}

// A yes/no question on the terminal that defaults to no.
async function askNo(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.once('line', resolve)
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Resolves once this root's daemon file names `pid` and answers health.
async function waitForDaemonPid(
  rootDir: string,
  pid: number | undefined,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonFile(rootDir);
    if (info?.pid === pid && info !== null && (await isHealthy(info.port)))
      return;
    await sleep(200);
  }
}

// Stops the daemon serving `rootDir` so this one can take over: a background
// one always, any other only with `replace`. It is asked over its API (the
// daemon file's agent token), refuses while work is live, and is waited for
// until its pid exits; nothing is ever killed by name or pattern.
async function stopForTakeover(
  ctx: CliContext,
  rootDir: string,
  replace: boolean
): Promise<void> {
  const info = readDaemonFile(rootDir);
  if (info === null || !pidAlive(info.pid)) return;
  const which = `pid ${info.pid}, port ${info.port}`;
  type Health = { pid?: number; rootDir?: string };
  let health: Health | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    health = res.ok ? ((await res.json()) as Health) : null;
  } catch (err) {
    if ((err as { name?: string }).name === 'TimeoutError')
      throw new CliError(
        `the dispatchd serving this project (${which}) is not answering; wait and retry, or, if it stays stuck, stop it yourself (kill ${info.pid}), which fails any run it has in flight.`
      );
  }
  // Nothing answers on its port: a stale file whose pid was reused.
  if (health === null) return;
  if (health.pid !== info.pid || health.rootDir !== info.rootDir)
    throw new CliError(
      `this project's daemon file names pid ${info.pid}, but port ${info.port} answers as pid ${health.pid ?? 'unknown'} for ${health.rootDir ?? 'another project'}; stop the stray daemon yourself, then run this again.`
    );
  if (info.background !== true && !replace)
    throw new CliError(
      `the Dispatch app or another \`dispatch serve\` is already serving this project (${which}); use that one, or run \`dispatch serve --replace\` to stop it once it has no live work and take over.`
    );
  const base = `http://127.0.0.1:${info.port}`;
  const authorization = `Bearer ${requireAgentToken(info)}`;
  const busy = (what: string) =>
    new CliError(
      `not taking over: the dispatchd serving this project (${which}) has live work (${what}). See it with \`dispatch runs\` or in the Dispatch app, and run this again once it finishes; nothing was stopped.`
    );
  // Work under way refuses; runs parked on a human are asked about, since
  // they resume after the takeover and only a fresh app token can answer them.
  let parked = false;
  const work = await fetch(`${base}/api/live-work`, {
    headers: { authorization },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 5),
  });
  if (work.ok) {
    const live = (await work.json()) as { busy: string[]; parked: string[] };
    if (live.busy.length > 0) throw busy(live.busy.join(', '));
    if (live.parked.length > 0) {
      const what = live.parked.join(', ');
      const why = `the dispatchd serving this project (${which}) has ${what}. Taking over stops it; those runs pick up again under the new daemon, and its token answers them (\`dispatch approve <run>\`, or in the app).`;
      const ask = ctx.confirm ?? (process.stdin.isTTY === true ? askNo : null);
      if (ask === null)
        throw new CliError(
          `not taking over without a terminal to confirm: ${why} Run \`dispatch serve\` in a terminal to answer the question.`
        );
      if (!(await ask(`${why} Take over?`)))
        throw new CliError('not taking over; nothing was stopped.');
      parked = true;
    }
  }
  const res = await fetch(`${base}/api/daemon/shutdown`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ parked }),
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS * 5),
  });
  if (res.status === 404)
    throw new CliError(
      `the dispatchd serving this project (${which}) predates taking over; once \`dispatch runs\` shows nothing live, stop it (kill ${info.pid}) and run this again.`
    );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      live?: string[];
    };
    // Work that began since the live-work read lands here.
    throw body.code === 'busy' || body.code === 'parked'
      ? busy(body.live?.join(', ') ?? '')
      : new CliError(
          `could not stop the dispatchd serving this project (${which}): ${body.error ?? res.status}`
        );
  }
  const deadline = Date.now() + HANDOVER_EXIT_WAIT_MS;
  while (pidAlive(info.pid) || readDaemonFile(rootDir)?.pid === info.pid) {
    if (Date.now() >= deadline)
      throw new CliError(
        `the dispatchd serving this project (${which}) agreed to stop but is still running after ${HANDOVER_EXIT_WAIT_MS / 1000}s; it may have started work meanwhile. Check \`dispatch runs\`, then run this again.`
      );
    await sleep(100);
  }
}

const A2A_OVERRIDE_HELP = 'override for this boot; see `dispatch a2a listen`';

export function registerDaemonCommands(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('serve')
    .description('Run dispatchd (REST + WebSocket + web UI) in the foreground')
    .option('--port <n>', 'port to listen on (default: ephemeral)')
    .option(
      '--host <addr>',
      '127.0.0.1 (default, this machine) or 0.0.0.0 (team-local: teammates sign in with `dispatch team invite` tokens)'
    )
    .option(
      '--public-origin <urls>',
      'team-local: extra comma-separated origins teammates load the app from'
    )
    .option('--web-dist <dir>', 'team-local: the built desktop bundle to serve')
    .option(
      '--tls-cert <file>',
      'team-local: serve teammates over HTTPS with this certificate (PEM)'
    )
    .option('--tls-key <file>', 'team-local: the private key for --tls-cert')
    .option(
      '--tls-port <n>',
      'team-local: port for the HTTPS listener (default: ephemeral)'
    )
    .option('--a2a-host <addr>', `A2A listener host ${A2A_OVERRIDE_HELP}`)
    .option('--a2a-port <n>', `A2A listener port ${A2A_OVERRIDE_HELP}`)
    .option('--a2a-public-url <url>', `A2A card URL ${A2A_OVERRIDE_HELP}`)
    .option(
      '--a2a-tls-cert <file>',
      `A2A listener certificate (PEM) ${A2A_OVERRIDE_HELP}`
    )
    .option(
      '--a2a-tls-key <file>',
      `A2A listener private key ${A2A_OVERRIDE_HELP}`
    )
    .option(
      '--replace',
      'also take over a daemon the Dispatch app or another `dispatch serve` started (a background one is taken over without it); refused while it has live work'
    )
    .action(async (opts: ServeOptions) => {
      // requireInitialized, NOT requireStore: the latter demands
      // `.dispatch/tasks`, which a database-backed project does not have and
      // never will. Gating on it made this command refuse to start the daemon
      // in exactly the projects that CANNOT be used without one — the CLI
      // sends them here ("Start it with: dispatch serve") and this sent them
      // back with "not initialized".
      requireInitialized(ctx);
      process.exitCode = await serveInForeground(
        ctx,
        projectRoot(ctx.cwd),
        opts
      );
    });

  program
    .command('ui')
    .description('Open the dispatch web UI, starting dispatchd if needed')
    .option('--port <n>', 'port to use when starting dispatchd')
    .action(async (opts: { port?: string }) => {
      // Same reason as `serve` above.
      requireInitialized(ctx);
      const { port } = await ensureDaemon(ctx, { port: opts.port });
      openBrowserFor(ctx, `http://127.0.0.1:${port}`);
    });
}
