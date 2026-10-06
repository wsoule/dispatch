import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { createApiClient, createTaskApiClient } from '../src/apiClient.js';
import { daemonFilePath, ensureDaemon } from '../src/commands/daemon.js';
import { makeProgram } from '../src/program.js';

// `dispatch serve` taking a project over from a real spawned dispatchd: it
// asks the old one to exit, waits for its pid, and only then boots, so two
// daemons never serve one root (2026-09-07). Only pids spawned here are killed.

const CLI_SRC = resolve(import.meta.dirname, '../src/cli.ts');
const SERVER_BIN = resolve(import.meta.dirname, '../../server/src/bin.ts');

type Proc = ChildProcessByStdio<null, Readable, Readable>;

let root: string;
let home: string;
let spawned: number[];
let children: Proc[];
const saved = {
  home: process.env.DISPATCH_HOME,
  fakes: process.env.DISPATCH_ENABLE_FAKES,
  linger: process.env.DISPATCH_FAKE_LINGER_MS,
  approval: process.env.DISPATCH_FAKE_APPROVAL,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonFile(): { pid: number; port: number; background?: boolean } {
  return JSON.parse(readFileSync(daemonFilePath(root), 'utf8')) as {
    pid: number;
    port: number;
    background?: boolean;
  };
}

// How many dispatchd processes serve this root right now (read-only pgrep).
function daemonCount(): number {
  try {
    return execFileSync('pgrep', ['-f', `bin.ts --root ${root}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

// Samples daemonCount until stopped; the most it ever saw.
function sampleDaemons(): () => number {
  let most = 0;
  const timer = setInterval(() => {
    most = Math.max(most, daemonCount());
  }, 50);
  return () => {
    clearInterval(timer);
    return Math.max(most, daemonCount());
  };
}

function track(proc: Proc): Proc {
  children.push(proc);
  if (proc.pid !== undefined) spawned.push(proc.pid);
  return proc;
}

function serve(...args: string[]): {
  proc: Proc;
  out: () => string;
  err: () => string;
  exit: Promise<number>;
} {
  const proc = track(
    // Spread so knip does not read `serve` as a binary to install.
    spawn('bun', [CLI_SRC, ...['serve', ...args]], {
      cwd: root,
      env: { ...process.env, DISPATCH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  let out = '';
  let err = '';
  proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
  proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
  const exit = new Promise<number>((r) =>
    proc.on('exit', (code) => r(code ?? 1))
  );
  return { proc, out: () => out, err: () => err, exit };
}

async function until(
  check: () => boolean,
  what: string,
  ms = 30_000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const TOKEN_LINE = /^DISPATCH_APP_TOKEN=[0-9a-f]{64}$/m;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-takeover-')));
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
  ])
    execFileSync('git', args, { cwd: root });
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: root,
  });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-takeover-home-')));
  process.env.DISPATCH_HOME = home;
  spawned = [];
  children = [];
});

afterEach(async () => {
  // The serve CLIs first (each passes SIGTERM on to its dispatchd), then any
  // daemon pid this test learned of; exact pids only.
  for (const p of children) if (p.exitCode === null) p.kill('SIGTERM');
  await Bun.sleep(500);
  for (const pid of spawned)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  restore('DISPATCH_HOME', saved.home);
  restore('DISPATCH_ENABLE_FAKES', saved.fakes);
  restore('DISPATCH_FAKE_LINGER_MS', saved.linger);
  restore('DISPATCH_FAKE_APPROVAL', saved.approval);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// Starts a fake run on `daemon` and resolves once it reaches `state`.
async function startFakeRun(
  daemon: { port: number; agentToken: string },
  state = 'running'
): Promise<void> {
  const base = `http://127.0.0.1:${daemon.port}`;
  const task = await createTaskApiClient(base, daemon.agentToken).createTask({
    title: 'Takeover',
  });
  const api = createApiClient(base, daemon.agentToken);
  const run = await api.createRun(task.meta.id, 'fake');
  const deadline = Date.now() + 30_000;
  while ((await api.listRuns()).find((r) => r.id === run.id)?.state !== state) {
    if (Date.now() > deadline) throw new Error(`run never reached ${state}`);
    await Bun.sleep(100);
  }
}

describe('dispatch serve takes over', () => {
  it('an idle background daemon: the old pid exits, then the new one serves and prints a token', async () => {
    const old = await ensureDaemon({ cwd: root, log: () => {} });
    spawned.push(old.pid);
    expect(old.background).toBe(true);

    const most = sampleDaemons();
    const s = serve();
    await until(() => TOKEN_LINE.test(s.out()), 'the new token');
    const seen = most();

    expect(alive(old.pid)).toBe(false);
    const now = daemonFile();
    spawned.push(now.pid);
    expect(now.pid).not.toBe(old.pid);
    expect(now.background).toBeUndefined();
    expect(seen).toBe(1);

    // An MCP or CLI call now finds the foreground daemon, never spawns one.
    const found = await ensureDaemon({ cwd: root, log: () => {} });
    expect(found.pid).toBe(now.pid);
    expect(daemonCount()).toBe(1);
  }, 90_000);

  it('refuses a background daemon with a live run, leaving it untouched and booting nothing', async () => {
    process.env.DISPATCH_ENABLE_FAKES = '1';
    process.env.DISPATCH_FAKE_LINGER_MS = '60000';
    const old = await ensureDaemon({ cwd: root, log: () => {} });
    spawned.push(old.pid);
    await startFakeRun(old);

    const s = serve();
    expect(await s.exit).toBe(1);
    expect(s.err()).toContain('has live work (1 live run)');
    expect(s.err()).toContain('nothing was stopped');
    expect(TOKEN_LINE.test(s.out())).toBe(false);
    expect(alive(old.pid)).toBe(true);
    expect(daemonFile().pid).toBe(old.pid);
    expect(daemonCount()).toBe(1);
  }, 90_000);

  it('a daemon the app or a terminal started only with --replace, stopping it first', async () => {
    const first = track(
      spawn('bun', [SERVER_BIN, '--root', root], {
        env: { ...process.env, DISPATCH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    const firstPid = first.pid ?? -1;
    await until(
      () => existsSync(daemonFilePath(root)) && daemonFile().pid === firstPid,
      'the first daemon'
    );

    const refused = serve();
    expect(await refused.exit).toBe(1);
    expect(refused.err()).toContain('dispatch serve --replace');
    expect(alive(firstPid)).toBe(true);

    const most = sampleDaemons();
    const s = serve('--replace');
    await until(() => TOKEN_LINE.test(s.out()), 'the new token');
    const seen = most();
    expect(alive(firstPid)).toBe(false);
    const now = daemonFile();
    spawned.push(now.pid);
    expect(now.pid).not.toBe(firstPid);
    expect(seen).toBe(1);
  }, 90_000);

  it('refuses runs parked on a human when nobody can confirm, saying they would resume', async () => {
    process.env.DISPATCH_ENABLE_FAKES = '1';
    process.env.DISPATCH_FAKE_APPROVAL = '1';
    process.env.DISPATCH_FAKE_LINGER_MS = '60000';
    const old = await ensureDaemon({ cwd: root, log: () => {} });
    spawned.push(old.pid);
    await startFakeRun(old, 'awaiting-approval');

    // stdin is not a terminal here, and the subprocess has no confirm seam.
    const s = serve();
    expect(await s.exit).toBe(1);
    expect(s.err()).toContain('without a terminal to confirm');
    expect(s.err()).toContain('1 run is waiting on you');
    expect(s.err()).toContain("They'll pick up again after the restart.");
    expect(s.err()).toContain('tool approvals will be asked again');
    expect(alive(old.pid)).toBe(true);
    expect(daemonFile().pid).toBe(old.pid);
  }, 90_000);

  it('takes over from parked runs once confirmed', async () => {
    process.env.DISPATCH_ENABLE_FAKES = '1';
    process.env.DISPATCH_FAKE_APPROVAL = '1';
    process.env.DISPATCH_FAKE_LINGER_MS = '60000';
    const old = await ensureDaemon({ cwd: root, log: () => {} });
    spawned.push(old.pid);
    await startFakeRun(old, 'awaiting-approval');

    const asked: string[] = [];
    // In process, so the confirm seam answers; the foreground dispatchd it
    // starts is stopped below by its exact pid, which ends the command.
    const done = makeProgram({
      cwd: root,
      log: () => {},
      confirm: (q) => {
        asked.push(q);
        return Promise.resolve(true);
      },
    }).parseAsync(['serve'], { from: 'user' });
    await until(
      () => !alive(old.pid) && existsSync(daemonFilePath(root)),
      'the takeover'
    );
    const now = daemonFile();
    spawned.push(now.pid);
    expect(now.pid).not.toBe(old.pid);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('1 run is waiting on you');
    expect(asked[0]).toContain('Questions stay open');
    process.kill(now.pid, 'SIGTERM');
    await done;
    // serve hands dispatchd's exit code to the process; not this runner's.
    process.exitCode = 0;
  }, 90_000);
});
