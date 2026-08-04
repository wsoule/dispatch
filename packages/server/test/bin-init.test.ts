import {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
} from '@dispatch/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
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
//
// 30s, not a tighter budget: every call site here waits on a REAL `bun BIN`
// subprocess boot plus (for the merge-driver tests) two more `git config`
// subprocesses, which can run slow under CPU contention with no call site
// overriding this default — raise it here, not per call.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 30_000,
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

    // Both, not just the tasks dir: init writes them one after the other, so
    // waiting on the first alone can catch the child between the two writes.
    const initialized = await waitFor(
      () => existsSync(tasksDir) && existsSync(configPath)
    );
    expect(initialized).toBe(true);
    expect(existsSync(tasksDir)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    // 45s: headroom past waitFor's 30s default so a genuine failure fails
    // cleanly instead of getting cut off by bun's own per-test timeout.
  }, 45_000);

  // Regression: this is the desktop app's project-init path
  // (GetStartedView -> TaskStore.init(rootDir) equivalent), which used to
  // skip merge-driver registration entirely — only the CLI's `dispatch init`
  // registered it, so a desktop-first project never got it.
  it('registers the task-file merge driver before the server starts', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-root-'));
    dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-home-'));
    spawnSync('git', ['init', '-q'], { cwd: rootDir });
    const gitattributesPath = join(rootDir, '.gitattributes');

    child = Bun.spawn(
      ['bun', BIN, '--root', rootDir, '--init', '--port', '0'],
      {
        env: { ...process.env, DISPATCH_HOME: dispatchHome },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    // Wait on BOTH drivers, not just the task one this test names — bin.ts
    // registers task then team sequentially (registerMergeDriverGitConfig,
    // then registerTeamMergeDriverGitConfig), and this test asserts on both
    // below. Waiting on task alone was a genuine race: task's `git config`
    // calls can land, and this predicate return true, before team's own two
    // calls have run, which showed up as an intermittent failure on the
    // checkTeamMergeDriverSetup assertion below — not a timeout, since it
    // failed in ~250ms, well inside even the old 10s budget.
    const registered = await waitFor(
      () =>
        checkMergeDriverSetup(rootDir!).gitConfig &&
        checkTeamMergeDriverSetup(rootDir!).gitConfig
    );
    expect(registered).toBe(true);
    expect(readFileSync(gitattributesPath, 'utf8')).toContain(
      '.dispatch/tasks/*.md merge=dispatch-task'
    );
    expect(checkMergeDriverSetup(rootDir)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    expect(checkTeamMergeDriverSetup(rootDir)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    // 45s: headroom past waitFor's 30s default so a genuine failure fails
    // cleanly instead of getting cut off by bun's own per-test timeout.
  }, 45_000);

  // Regression: --init used to gate driver registration behind the same
  // "tasks dir missing" check as TaskStore.init, so a project that predates
  // the drivers (or lost its local git config) never got repaired by a
  // later `--init` run — only a project's very first init ever registered
  // them. Simulates that predating project directly (scaffold + git init,
  // no driver setup), then confirms a later --init repairs it.
  it('repairs the merge drivers on an already-initialized project', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-root-'));
    dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-bin-init-home-'));
    spawnSync('git', ['init', '-q'], { cwd: rootDir });
    mkdirSync(join(rootDir, '.dispatch', 'tasks'), { recursive: true });
    expect(checkMergeDriverSetup(rootDir)).toEqual({
      gitattributes: false,
      gitConfig: false,
    });

    child = Bun.spawn(
      ['bun', BIN, '--root', rootDir, '--init', '--port', '0'],
      {
        env: { ...process.env, DISPATCH_HOME: dispatchHome },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    const registered = await waitFor(
      () => checkTeamMergeDriverSetup(rootDir!).gitConfig
    );
    expect(registered).toBe(true);
    expect(checkMergeDriverSetup(rootDir)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    expect(checkTeamMergeDriverSetup(rootDir)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    // 45s: headroom past waitFor's 30s default so a genuine failure fails
    // cleanly instead of getting cut off by bun's own per-test timeout.
  }, 45_000);

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
    // 45s: headroom past waitFor's 30s default so a genuine failure fails
    // cleanly instead of getting cut off by bun's own per-test timeout.
  }, 45_000);
});
