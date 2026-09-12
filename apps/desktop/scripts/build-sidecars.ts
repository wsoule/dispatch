#!/usr/bin/env bun
// Compiles the three sidecar binaries the desktop app bundles as resources —
// dispatchd (packages/server), dispatch-mcp (packages/mcp), and dispatch-cli
// (packages/cli) — into
// standalone `bun build --compile` executables under src-tauri/resources/.
//
// When `APPLE_SIGNING_IDENTITY` is set on macOS, each binary is also
// codesigned with the hardened runtime + the JIT entitlements bun executables
// need (src-tauri/entitlements/sidecar.plist). Tauri's bundler signs the app
// executable and frameworks itself but does not sign plain executables under
// `bundle.resources`, and notarization rejects a bundle containing any
// unsigned executable — so the sidecars must arrive at bundling already
// signed. Without the env var this is compile-only, matching the previous
// unsigned behavior for local/dev builds.
//
// Usage: `bun run build:sidecars` from apps/desktop (also runs as part of
// `build:app`, which tauri.conf.json's beforeBuildCommand invokes).

import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopDir, '..', '..');
const resourcesDir = join(desktopDir, 'src-tauri', 'resources');
const entitlements = join(
  desktopDir,
  'src-tauri',
  'entitlements',
  'sidecar.plist'
);

const SIDECARS = [
  {
    entry: join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
    name: 'dispatchd',
    // The event-loop watchdog runs on a Worker, which a compiled binary only
    // embeds when its module is a build entrypoint of its own — otherwise
    // `new Worker(...)` fails silently at runtime and the daemon boots with
    // no watchdog. Keep in step with packages/server/src/watchdog.ts.
    extraEntries: [
      join(repoRoot, 'packages', 'server', 'src', 'watchdogWorker.ts'),
    ],
  },
  {
    entry: join(repoRoot, 'packages', 'mcp', 'src', 'bin.ts'),
    name: 'dispatch-mcp',
  },
  // The `dispatch` CLI, compiled so the Homebrew cask can expose it on PATH
  // (see the cask's `binary` stanza) without requiring `bun` or the checkout.
  // Its `dispatch mcp` subcommand runs the bundled MCP server in-process, and
  // `dispatch`/`dispatch serve` spawn the `dispatchd` binary sitting beside it
  // in this same Resources dir — see resolveDaemonLauncher in
  // packages/cli/src/commands/daemon.ts.
  {
    entry: join(repoRoot, 'packages', 'cli', 'src', 'cli.ts'),
    name: 'dispatch-cli',
  },
];

// `bun build --compile` (Bun 1.3.x) leaves a stray `.<hash>-00000000.bun-build`
// staging file in its invocation cwd even on success — same cleanup the root
// scripts/build-sidecar.ts does.
function cleanupBunBuildArtifacts(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.bun-build')) rmSync(join(dir, entry), { force: true });
  }
}

function run(label: string, cmd: string[]): void {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`build-sidecars: ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

/** The filename Bun writes and Tauri bundles on a given host platform. */
export function sidecarExecutableName(
  name: string,
  platform: NodeJS.Platform
): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function main(): void {
  for (const { entry, name, extraEntries = [] } of SIDECARS) {
    const executableName = sidecarExecutableName(name, process.platform);
    const outfile = join(resourcesDir, executableName);
    run(`compile ${executableName}`, [
      'bun',
      'build',
      '--compile',
      entry,
      ...extraEntries,
      '--outfile',
      outfile,
    ]);
    if (process.platform !== 'win32') chmodSync(outfile, 0o755);
  }
  cleanupBunBuildArtifacts(desktopDir);

  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (process.platform === 'darwin' && identity) {
    for (const { name } of SIDECARS) {
      run(`codesign ${name}`, [
        'codesign',
        '--force',
        '--sign',
        identity,
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        '--timestamp',
        join(resourcesDir, sidecarExecutableName(name, process.platform)),
      ]);
    }
    console.log(
      `build-sidecars: signed all ${SIDECARS.length} sidecars as "${identity}"`
    );
  } else {
    console.log(
      'build-sidecars: APPLE_SIGNING_IDENTITY not set — sidecars left unsigned'
    );
  }
}

if (import.meta.main) main();
