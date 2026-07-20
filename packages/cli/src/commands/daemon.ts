import type { Command } from 'commander';
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
// (and apps/desktop/src-tauri/src/sidecar.rs's `daemon_home` and
// packages/mcp/src/daemon.ts's reader — a third and fourth copy of the same
// scheme) if it ever changes; test/daemon-cmd.test.ts cross-checks the hash
// against a fixture so drift fails loudly.
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
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

function openBrowserFor(ctx: CliContext, url: string): void {
  (ctx.openBrowser ?? defaultOpenBrowser)(url);
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

      const existing = readDaemonFile(ctx.cwd);
      if (existing !== null && (await isHealthy(existing.port))) {
        openBrowserFor(ctx, `http://127.0.0.1:${existing.port}`);
        return;
      }

      const binPath = resolveDaemonBin();
      const args = [binPath, '--root', ctx.cwd];
      if (opts.port !== undefined) args.push('--port', opts.port);

      // Detached + ignored stdio: this daemon should outlive `dispatch ui`
      // and keep running in the background, the same way `dispatch serve`
      // running in a separate terminal would.
      const child = spawn('bun', args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // Surfaced below via the health-poll timeout instead of here — by
        // the time this fires asynchronously, the action may already have
        // moved on to polling, so there's nothing safe to throw into.
      });
      child.unref();

      const port = await waitForHealthyDaemon(ctx.cwd, 5000);
      if (port === null) {
        throw new CliError(
          'dispatchd did not become healthy within 5s (is bun installed? https://bun.sh)'
        );
      }
      openBrowserFor(ctx, `http://127.0.0.1:${port}`);
    });
}
