import { seedSession, type SessionPaths } from '@dispatch/demo/seed';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDaemonStdout } from './stdoutContract.js';

export interface Session {
  id: string;
  paths: SessionPaths;
  port: number;
  agentToken: string;
  appToken: string;
  proc: Bun.Subprocess;
  createdAt: number;
  lastSeenAt: number;
  // setTimeout handles the teammate puppet script schedules against this
  // session (a later task); destroy() clears whatever has accumulated here.
  timers: Array<ReturnType<typeof setTimeout>>;
}

export interface SessionManagerOptions {
  sessionsDir?: string;
  maxSessions?: number;
  ttlMs?: number;
  daemonPath?: string;
}

export class SessionCapError extends Error {
  constructor() {
    super('session cap reached');
    this.name = 'SessionCapError';
  }
}

/** Where every session sandbox lands; server.ts checks it is writable at boot. */
export const DEFAULT_SESSIONS_DIR = join(tmpdir(), 'dispatch-demo-sessions');
const DEFAULT_DAEMON_PATH = join(import.meta.dir, 'daemon.ts');
const SWEEP_INTERVAL_MS = 60_000;
const STDOUT_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Owns every live per-visitor demo daemon: seeds a fresh sandbox, spawns and
 * health-checks the daemon, tracks liveness, and tears sessions down on
 * request or once they've been idle past the TTL.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  // Ids reserved by a create() call that's still seeding/spawning/waiting on
  // stdout — not yet in `sessions`. count() includes these so a second
  // create() racing the first one's async work still sees the slot as taken.
  private readonly pending = new Set<string>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private stopped = false;
  private readonly sessionsDir: string;
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly daemonPath: string;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions = {}) {
    this.sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.maxSessions =
      opts.maxSessions ?? Number(process.env.DEMO_MAX_SESSIONS ?? 12);
    this.ttlMs =
      opts.ttlMs ?? Number(process.env.DEMO_SESSION_TTL_MS ?? 1_800_000);
    this.daemonPath = opts.daemonPath ?? DEFAULT_DAEMON_PATH;
    this.sweepInterval = setInterval(
      () => void this.sweep(),
      SWEEP_INTERVAL_MS
    );
    this.sweepInterval.unref?.();
  }

  /** Throws SessionCapError when at capacity. Resolves once the daemon is healthy. */
  async create(): Promise<Session> {
    if (this.stopped) {
      throw new Error('SessionManager is stopped');
    }
    // Cap check + reservation are synchronous (no await between them), so
    // two concurrent create() calls can't both pass the check before either
    // one registers — the loser sees the reservation and rejects here,
    // without ever seeding or spawning.
    if (this.count() >= this.maxSessions) {
      throw new SessionCapError();
    }
    const id = randomBytes(8).toString('hex');
    this.pending.add(id);
    const task = this.doCreate(id);
    this.inFlight.set(id, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(id);
      this.pending.delete(id);
    }
  }

  // Seeds, spawns, and health-checks one session. Split out from create()
  // so the reservation bookkeeping in create() stays synchronous and so
  // stop() can await this promise directly via `inFlight`.
  private async doCreate(id: string): Promise<Session> {
    const dir = join(this.sessionsDir, id);
    let proc: Bun.Subprocess<'ignore', 'pipe', 'inherit'> | undefined;
    try {
      const paths = seedSession(dir);
      proc = Bun.spawn(['bun', this.daemonPath, '--root', paths.root], {
        env: { ...process.env, DISPATCH_HOME: paths.home },
        stdout: 'pipe',
        // 'inherit': same reasoning as test/daemon.test.ts — an unread pipe
        // fills up and stalls the daemon once it logs enough console.error.
        stderr: 'inherit',
      });
      const out = await parseDaemonStdout(proc.stdout, STDOUT_TIMEOUT_MS);

      // stop() may have run while we were awaiting stdout; we're not in
      // `sessions` yet so it never tore us down — do it ourselves.
      if (this.stopped) {
        throw new Error('SessionManager is stopped');
      }

      const now = Date.now();
      const session: Session = {
        id,
        paths,
        port: out.port,
        agentToken: out.agentToken,
        appToken: out.appToken,
        proc,
        createdAt: now,
        lastSeenAt: now,
        timers: [],
      };
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      if (proc !== undefined) await this.killProc(proc);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; the original failure above is what matters
      }
      throw err;
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Bumps lastSeenAt; called by the proxy on every forwarded request. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session !== undefined) session.lastSeenAt = Date.now();
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    this.sessions.delete(id);
    for (const timer of session.timers) clearTimeout(timer);
    await this.killProc(session.proc);
    rmSync(session.paths.dir, { recursive: true, force: true });
  }

  /** Destroys every session idle longer than ttlMs. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const idle = [...this.sessions.values()].filter(
      (session) => now - session.lastSeenAt > this.ttlMs
    );
    await Promise.all(idle.map((session) => this.destroy(session.id)));
  }

  /** rm -rf the sessions dir; called once at boot before serving. */
  static reap(sessionsDir: string = DEFAULT_SESSIONS_DIR): void {
    rmSync(sessionsDir, { recursive: true, force: true });
  }

  count(): number {
    return this.sessions.size + this.pending.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepInterval);
    // Let in-flight create() calls notice `stopped` and tear themselves
    // down (or finish registering, if they're already past that check)
    // before sweeping whatever ended up in `sessions`.
    await Promise.allSettled([...this.inFlight.values()]);
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }

  // Sends SIGTERM, then escalates to SIGKILL if proc hasn't exited within
  // KILL_TIMEOUT_MS — a wedged demo daemon must never hang a destroy().
  private async killProc(proc: Bun.Subprocess): Promise<void> {
    proc.kill();
    const timer = setTimeout(() => proc.kill('SIGKILL'), KILL_TIMEOUT_MS);
    timer.unref?.();
    await proc.exited;
    clearTimeout(timer);
  }
}
