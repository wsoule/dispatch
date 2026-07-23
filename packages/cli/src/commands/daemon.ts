import type { Command } from 'commander';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { type CliContext, CliError } from '../context.js';
import { requireStore } from './task.js';

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
}

function daemonHome(): string {
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
function resolveDaemonBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

// Default `openBrowser` used when a CliContext doesn't inject its own (tests
// inject a stub; real usage falls through to here).
function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
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
    { stdio: 'ignore', detached: true }
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
export function openDesktopOrBrowser(ctx: CliContext, port: number): void {
  if (process.platform === 'darwin') {
    const probe = spawnSync('open', ['-Ra', DESKTOP_PRODUCT_NAME]);
    if (probe.status === 0) {
      (ctx.openApp ?? defaultOpenApp)(ctx.cwd);
      return;
    }
  }
  openBrowserFor(ctx, `http://127.0.0.1:${port}`);
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
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
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const info = readDaemonFile(rootDir);
    if (info !== null && (await isHealthy(info.port))) return info.port;
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

export interface EnsureDaemonOptions {
  // Port to request when a fresh daemon must be spawned (default: ephemeral,
  // same as `dispatch serve`/`dispatch ui` with no `--port`).
  port?: string;
}

// Shared "get me a healthy daemon for this project, starting one if none is
// running" logic — every command that needs to talk to dispatchd (`dispatch
// ui`, and every Phase 7 orchestrate/plan/epic command) goes through this
// exact same path: reuse an already-healthy daemon found via its daemon
// file, or spawn a fresh detached one and poll until it answers
// `/api/health`. Extracted from `dispatch ui`'s own action (which now just
// calls this and opens a browser at the result) so headless commands get
// identical auto-start behavior without duplicating it.
export async function ensureDaemon(
  ctx: CliContext,
  opts: EnsureDaemonOptions = {}
): Promise<{ port: number }> {
  const existing = readDaemonFile(ctx.cwd);
  if (existing !== null && (await isHealthy(existing.port))) {
    return { port: existing.port };
  }

  const binPath = resolveDaemonBin();
  const args = [binPath, '--root', ctx.cwd];
  if (opts.port !== undefined) args.push('--port', opts.port);

  // Detached + ignored stdio: this daemon should outlive the CLI invocation
  // that spawned it and keep running in the background, the same way
  // `dispatch serve` running in a separate terminal would. No `env` override
  // is passed, so the child inherits this process's full environment —
  // including `DISPATCH_ENABLE_FAKES`/`DISPATCH_HOME` when a test (or a
  // user) has set them, which is what lets the CLI's own e2e tests exercise
  // this exact auto-start path against a fakes-enabled daemon.
  const child = spawn('bun', args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Surfaced below via the health-poll timeout instead of here — by the
    // time this fires asynchronously, the caller may already have moved on
    // to polling, so there's nothing safe to throw into.
  });
  child.unref();

  const port = await waitForHealthyDaemon(ctx.cwd, 5000);
  if (port === null) {
    throw new CliError(
      'dispatchd did not become healthy within 5s (is bun installed? https://bun.sh)'
    );
  }
  return { port: await resolveRaceWinner(ctx.cwd, child, port) };
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
  fallbackPort: number
): Promise<number> {
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
    return info.port;
  }
  return fallbackPort;
}

export function registerDaemonCommands(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('serve')
    .description('Run dispatchd (REST + WebSocket + web UI) in the foreground')
    .option('--port <n>', 'port to listen on (default: ephemeral)')
    .action((opts: { port?: string }) => {
      requireStore(ctx);
      const binPath = resolveDaemonBin();
      const args = [binPath, '--root', ctx.cwd];
      if (opts.port !== undefined) args.push('--port', opts.port);

      const result = spawnSync('bun', args, { stdio: 'inherit' });
      if (result.error !== undefined) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CliError('dispatch serve requires bun (https://bun.sh)');
        }
        throw result.error;
      }
      process.exitCode = result.status ?? 0;
    });

  program
    .command('ui')
    .description('Open the dispatch web UI, starting dispatchd if needed')
    .option('--port <n>', 'port to use when starting dispatchd')
    .action(async (opts: { port?: string }) => {
      requireStore(ctx);
      const { port } = await ensureDaemon(ctx, { port: opts.port });
      openBrowserFor(ctx, `http://127.0.0.1:${port}`);
    });
}
