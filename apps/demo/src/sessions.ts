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

const DEFAULT_SESSIONS_DIR = join(tmpdir(), 'dispatch-demo-sessions');
const DEFAULT_DAEMON_PATH = join(import.meta.dir, 'daemon.ts');
const SWEEP_INTERVAL_MS = 60_000;
const STDOUT_TIMEOUT_MS = 20_000;

/**
 * Owns every live per-visitor demo daemon: seeds a fresh sandbox, spawns and
 * health-checks the daemon, tracks liveness, and tears sessions down on
 * request or once they've been idle past the TTL.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
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
    if (this.count() >= this.maxSessions) {
      throw new SessionCapError();
    }

    const id = randomBytes(8).toString('hex');
    const dir = join(this.sessionsDir, id);
    const paths = seedSession(dir);

    const proc = Bun.spawn(['bun', this.daemonPath, '--root', paths.root], {
      env: { ...process.env, DISPATCH_HOME: paths.home },
      stdout: 'pipe',
      // 'inherit': same reasoning as test/daemon.test.ts — an unread pipe
      // fills up and stalls the daemon once it logs enough console.error.
      stderr: 'inherit',
    });

    let out;
    try {
      out = await parseDaemonStdout(proc.stdout, STDOUT_TIMEOUT_MS);
    } catch (err) {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
      throw err;
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
    session.proc.kill();
    await session.proc.exited;
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
    return this.sessions.size;
  }

  async stop(): Promise<void> {
    clearInterval(this.sweepInterval);
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}
