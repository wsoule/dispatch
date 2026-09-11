import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The shipped daemon is a `bun build --compile` binary, and a compiled binary
// embeds only what its build entrypoints reach. The watchdog's worker is
// loaded by `new Worker(new URL(...))` — a runtime path the bundler never
// follows — so it is only in the binary if it is passed as an entrypoint of
// its own (apps/desktop/scripts/build-sidecars.ts `extraEntries`). Without
// it the daemon boots, serves, and runs with no watchdog; the only trace is
// one stderr line at boot.
//
// scripts/check-worker-entries.ts guards the declaration statically. This
// test proves the mechanism itself: compiled the declared way, the daemon
// reports its watchdog `armed` at GET /api/health; compiled without the
// entry, it reports `failed`. The compile is ~0.5s.
const SRC = resolve(import.meta.dirname, '../src');
const BIN = join(SRC, 'bin.ts');
const WORKER = join(SRC, 'watchdogWorker.ts');

let work: string | undefined;
let child: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;

afterEach(async () => {
  child?.kill('SIGKILL');
  await child?.exited;
  child = undefined;
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
  work = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

// Compiles the daemon into `work` with the given entries; the cwd is `work`
// so the `.bun-build` staging file bun leaves behind is deleted with it.
function compileDaemon(entries: string[]): string {
  const outfile = join(work!, 'dispatchd');
  const build = Bun.spawnSync({
    cmd: ['bun', 'build', '--compile', ...entries, '--outfile', outfile],
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(`bun build --compile failed:\n${build.stderr.toString()}`);
  }
  return outfile;
}

// Boots the compiled binary against an empty project and returns the
// watchdog status its health endpoint reports once it is listening.
async function bootAndReadWatchdog(binary: string): Promise<string> {
  const root = join(work!, 'project');
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'statuses: [draft, ready, working, review, landing, landed, dropped]\nautoCommit: false\n'
  );
  const home = join(work!, 'home');
  mkdirSync(home);
  process.env.DISPATCH_HOME = home;

  child = Bun.spawn({
    cmd: [binary, '--root', root, '--port', '0'],
    env: { ...process.env, DISPATCH_HOME: home },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let port: number | null = null;
  const deadline = Date.now() + 20_000;
  while (port === null && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    const match = /dispatchd listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(
      output
    );
    if (match !== null) port = Number(match[1]);
  }
  reader.releaseLock();
  if (port === null) throw new Error(`daemon never listened:\n${output}`);

  // The worker's `ready` lands a beat after the listen line; poll briefly
  // so `starting` is not mistaken for the answer.
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as { watchdog?: string };
    if (body.watchdog !== 'starting' || Date.now() >= deadline) {
      return body.watchdog ?? 'missing';
    }
    await Bun.sleep(50);
  }
}

describe('compiled dispatchd', () => {
  it('arms its watchdog when the worker is a compile entry', async () => {
    work = mkdtempSync(join(tmpdir(), 'dispatch-compiled-watchdog-'));
    const binary = compileDaemon([BIN, WORKER]);
    expect(await bootAndReadWatchdog(binary)).toBe('armed');
  }, 60_000);

  // The failure mode the entry exists to prevent, kept as the control: if
  // the bundler ever starts following the Worker URL on its own this stops
  // failing, and the guard on build-sidecars.ts can be retired.
  it('reports a failed watchdog when the worker is left out', async () => {
    work = mkdtempSync(join(tmpdir(), 'dispatch-compiled-watchdog-'));
    const binary = compileDaemon([BIN]);
    expect(await bootAndReadWatchdog(binary)).toBe('failed');
  }, 60_000);
});
