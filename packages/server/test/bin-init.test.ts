import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { daemonFilePath } from '../src/daemonfile.js';

// The real script under test — spawned as a subprocess (not imported) so this
// exercises exactly what `dispatch serve`/the desktop app's sidecar actually
// run, argv parsing and all.
const BIN = resolve(import.meta.dirname, '../src/bin.ts');

// Repeatedly checks `predicate` until it's true or `timeoutMs` elapses.
// Needed because the daemon this spawns boots (and, when `--init` is passed,
// initializes the project) asynchronously in a child process — there's no
// synchronous signal from the parent's point of view.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await Bun.sleep(intervalMs);
  }
}

// Per-test state, torn down in afterEach regardless of pass/fail: the
// spawned daemon (always killed), plus its two temp dirs (project root and
// redirected DISPATCH_HOME, mirroring daemonfile.test.ts's convention).
let child: ReturnType<typeof Bun.spawn> | undefined;
let rootDir: string | undefined;
let dispatchHome: string | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  if (dispatchHome) rmSync(dispatchHome, { recursive: true, force: true });
  rootDir = undefined;
  dispatchHome = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

describe('bin.ts --init', () => {
  it('initializes an uninitialized project before the server starts', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-root-'));
    dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-home-'));
    const tasksDir = join(rootDir, '.dispatch', 'tasks');
    const configPath = join(rootDir, '.dispatch', 'config.yml');
    expect(existsSync(tasksDir)).toBe(false);

    child = Bun.spawn(
      ['bun', BIN, '--root', rootDir, '--init', '--port', '0'],
      {
        env: { ...process.env, DISPATCH_HOME: dispatchHome },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    const initialized = await waitFor(() => existsSync(tasksDir));
    expect(initialized).toBe(true);
    expect(existsSync(tasksDir)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  }, 15_000);

  it('does not initialize the project when --init is absent', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-root-'));
    dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-home-'));
    const configPath = join(rootDir, '.dispatch', 'config.yml');

    child = Bun.spawn(['bun', BIN, '--root', rootDir, '--port', '0'], {
      env: { ...process.env, DISPATCH_HOME: dispatchHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Proof the daemon actually booted (as opposed to "just hasn't reached
    // the init check yet"): its daemon file appears under the redirected
    // DISPATCH_HOME. daemonFilePath() reads DISPATCH_HOME from *this*
    // process's env, so it must be set here to match what the child sees.
    process.env.DISPATCH_HOME = dispatchHome;
    const booted = await waitFor(() => existsSync(daemonFilePath(rootDir!)));
    expect(booted).toBe(true);

    // `.dispatch/tasks` itself is NOT a reliable signal here: startServer's
    // watcher (watcher.ts's watchTasks) lazily mkdir's it as a crash-safety
    // fallback any time it's missing, `--init` or not — see its own comment.
    // `config.yml`, written only by TaskStore.init, is the one file that
    // actually distinguishes "the project was initialized" from "the daemon
    // merely tolerated a missing tasks dir."
    expect(existsSync(configPath)).toBe(false);
  }, 15_000);
});
