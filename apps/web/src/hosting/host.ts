import { TaskStore } from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Runs one real dispatchd per hosted Linear workspace, so app.dispatch.foo's
// planner is the same engine as the desktop (allocation, warnings, digests,
// planning settings, audit, Linear sync). Each lives under
// <dataDir>/workspaces/<orgId>/ (`root`, its project; `home`, its
// DISPATCH_HOME), starts on first use, stops after `idleMs` unused, and is
// started again on the next request after a crash. The host alone holds a
// daemon's app token; members reach it with teammate tokens.

export interface HostedDaemon {
  port: number;
  appToken: string;
}

export interface WorkspaceHostOptions {
  dataDir: string;
  /** The daemon entry script (daemonEntry.ts). */
  entry: string;
  /** Linear app settings the daemon refreshes grants with. */
  env?: Record<string, string>;
  idleMs?: number;
  bootTimeoutMs?: number;
  now?: () => number;
}

interface Running extends HostedDaemon {
  proc: ReturnType<typeof Bun.spawn>;
  lastUsed: number;
}

const PORT = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
const APP_TOKEN = /DISPATCH_APP_TOKEN=([0-9a-f]+)/;

// The daemon's stdout until it has printed its port and app token.
async function readBoot(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number
): Promise<HostedDaemon> {
  const reader = stream.getReader();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  try {
    while (Date.now() < deadline) {
      const port = PORT.exec(buf)?.[1];
      const appToken = APP_TOKEN.exec(buf)?.[1];
      if (port !== undefined && appToken !== undefined)
        return { port: Number(port), appToken };
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error('a hosted dispatchd did not start in time');
}

export class WorkspaceHost {
  private readonly running = new Map<string, Running>();
  private readonly booting = new Map<string, Promise<Running>>();
  // Daemons asked to stop that have not exited: a new one on the same root
  // waits for them, so two never share a store.
  private readonly stopping = new Map<string, Promise<void>>();
  private closing = false;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly opts: WorkspaceHostOptions) {
    this.now = opts.now ?? Date.now;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
  }

  paths(orgId: string): { root: string; home: string } {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(orgId)) throw new Error('bad org id');
    const base = join(this.opts.dataDir, 'workspaces', orgId);
    return { root: join(base, 'root'), home: join(base, 'home') };
  }

  /**
   * Hands a workspace install to its daemon: written 0600 to its home as
   * install.json, which the daemon stores as its Linear connection on boot.
   * A running daemon is stopped so the next request boots with it.
   */
  async install(orgId: string, record: LinearAccountRecord): Promise<void> {
    const { home } = this.prepare(orgId);
    writeFileSync(join(home, 'install.json'), JSON.stringify(record), {
      mode: 0o600,
    });
    await this.stop(orgId);
  }

  /**
   * Replaces the workspace's project with what `seed` writes into a fresh
   * root (the demo), stopping its daemon first; the next request boots on it.
   */
  async replace(orgId: string, seed: (root: string) => void): Promise<void> {
    await this.stop(orgId);
    const { root, home } = this.paths(orgId);
    rmSync(join(root, '..'), { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(root, { recursive: true });
    seed(root);
  }

  /** The workspace's daemon, started (or restarted) if it is not running. */
  async ensure(orgId: string): Promise<HostedDaemon> {
    if (this.closing) throw new Error('the workspace host is shutting down');
    const live = this.running.get(orgId);
    if (live !== undefined && live.proc.exitCode === null) {
      live.lastUsed = this.now();
      return live;
    }
    this.running.delete(orgId);
    let boot = this.booting.get(orgId);
    if (boot === undefined) {
      boot = (this.stopping.get(orgId) ?? Promise.resolve())
        .then(() => this.boot(orgId))
        .finally(() => this.booting.delete(orgId));
      this.booting.set(orgId, boot);
    }
    return boot;
  }

  /** A request to the workspace's daemon, as its owner (app token) unless a
   *  member's token is given. */
  async request(
    orgId: string,
    path: string,
    init: RequestInit = {},
    token?: string
  ): Promise<Response> {
    const daemon = await this.ensure(orgId);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token ?? daemon.appToken}`);
    headers.delete('origin');
    headers.delete('host');
    headers.delete('cookie');
    return fetch(`http://127.0.0.1:${String(daemon.port)}${path}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
  }

  /** Stops the workspace's daemon, including one still booting. */
  async stop(orgId: string): Promise<void> {
    const booting = this.booting.get(orgId);
    if (booting !== undefined) await booting.catch(() => undefined);
    const live = this.running.get(orgId);
    this.running.delete(orgId);
    if (live === undefined || live.proc.exitCode !== null)
      return this.stopping.get(orgId);
    live.proc.kill('SIGTERM');
    const killer = setTimeout(() => live.proc.kill('SIGKILL'), 5_000);
    const exited = live.proc.exited.then(() => {
      clearTimeout(killer);
      this.stopping.delete(orgId);
    });
    this.stopping.set(orgId, exited);
    await exited;
  }

  /** Stops every daemon; nothing new boots after this starts. */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweeper);
    const ids = new Set([...this.running.keys(), ...this.booting.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  // A workspace's project on first use: a git repo (the daemon reads its
  // identity from it), the SQLite store, and Linear sync on. Idempotent.
  private prepare(orgId: string): { root: string; home: string } {
    const paths = this.paths(orgId);
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    if (existsSync(join(paths.root, '.dispatch'))) return paths;
    mkdirSync(paths.root, { recursive: true });
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: paths.root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Dispatch');
    git('config', 'user.email', 'planner@dispatch.foo');
    git('commit', '-q', '--allow-empty', '-m', 'Hosted planner');
    TaskStore.init(paths.root);
    writeFileSync(
      join(paths.root, '.dispatch', 'storage.json'),
      `${JSON.stringify({ backend: 'sqlite' })}\n`
    );
    writeFileSync(
      join(paths.root, '.dispatch', 'config.yml'),
      'autoCommit: false\nlinear:\n  enabled: true\n  direction: both\n'
    );
    return paths;
  }

  private async boot(orgId: string): Promise<Running> {
    const { root, home } = this.prepare(orgId);
    const proc = Bun.spawn(['bun', this.opts.entry, '--root', root], {
      env: {
        PATH: process.env.PATH ?? '',
        DISPATCH_HOME: home,
        DISPATCH_HUB: '0',
        ...this.opts.env,
      },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const daemon = await readBoot(
        proc.stdout,
        this.opts.bootTimeoutMs ?? 30_000
      );
      const live: Running = { ...daemon, proc, lastUsed: this.now() };
      this.running.set(orgId, live);
      // Drain the rest of stdout so the pipe never fills and blocks it.
      void proc.stdout.pipeTo(new WritableStream());
      return live;
    } catch (err) {
      proc.kill('SIGKILL');
      throw err;
    }
  }

  private async sweep(): Promise<void> {
    const idle = this.opts.idleMs ?? 30 * 60_000;
    for (const [orgId, live] of this.running)
      if (this.now() - live.lastUsed > idle) await this.stop(orgId);
  }
}
