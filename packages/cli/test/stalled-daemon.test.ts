import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  daemonFilePath,
  ensureDaemon,
  findRunningDaemon,
} from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';

// A stand-in for a dispatchd too busy to answer: it accepts the connection
// and never responds, which is what a real daemon looks like from the CLI
// while it provisions several run worktrees at once.
function stalledServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
}

// Bun types `Server.port` as optional (unix-socket servers have none); every
// server here binds TCP, so an absent port is a test bug, not a case.
function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error('test server has no port');
  return server.port;
}

let root: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

function writeDaemonFile(port: number, pid: number): void {
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid,
      rootDir: root,
      startedAt: '2026-09-07T14:38:00Z',
      agentToken: 'test-agent-token',
    })
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-stalled-'));
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-stalled-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// 2026-09-07: a `dispatch runs` against a daemon busy resuming seven runs hit
// the 2s health deadline, ensureDaemon read that as "no daemon" and spawned a
// second dispatchd, whose boot reconcile force-failed all seven. Twice.
describe('a live daemon whose health check stalls', () => {
  it('ensureDaemon waits, then errors naming the pid — it never spawns a second daemon', async () => {
    const server = stalledServer();
    try {
      writeDaemonFile(portOf(server), process.pid);
      const ctx: CliContext = { cwd: root, log: () => {} };
      const before = readFileSync(daemonFilePath(root), 'utf8');
      const started = Date.now();

      await expect(
        ensureDaemon(ctx, { healthTimeoutMs: 100, stalledWaitMs: 400 })
      ).rejects.toThrow(
        new RegExp(`pid ${process.pid}.*has not answered a health check`)
      );

      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      // No spawn happened: the daemon file still names this very process.
      expect(readFileSync(daemonFilePath(root), 'utf8')).toBe(before);
    } finally {
      await server.stop(true);
    }
  });

  it('findRunningDaemon attaches as soon as the stalled daemon starts answering', async () => {
    let stalled = true;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        stalled ? new Promise<Response>(() => {}) : Response.json({ ok: true }),
    });
    try {
      writeDaemonFile(portOf(server), process.pid);
      setTimeout(() => {
        stalled = false;
      }, 250);

      const conn = await findRunningDaemon(root, {
        healthTimeoutMs: 100,
        stalledWaitMs: 5000,
      });

      expect(conn).toEqual({
        port: portOf(server),
        agentToken: 'test-agent-token',
      });
    } finally {
      await server.stop(true);
    }
  });

  it('findRunningDaemon treats a stall from a dead pid as a stale file', async () => {
    const server = stalledServer();
    try {
      writeDaemonFile(portOf(server), 999_999);
      const started = Date.now();

      const conn = await findRunningDaemon(root, {
        healthTimeoutMs: 100,
        stalledWaitMs: 5000,
      });

      expect(conn).toBeNull();
      // Gave up on the first probe rather than waiting out the stall budget.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await server.stop(true);
    }
  });
});
