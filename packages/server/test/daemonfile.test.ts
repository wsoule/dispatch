import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertRootNotServed,
  daemonFileKey,
  daemonFilePath,
  readDaemonFile,
  removeDaemonFile,
  writeDaemonFile,
} from '../src/daemonfile.js';

let fakeHome: string;
let rootDir: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  rootDir = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

describe('writeDaemonFile / readDaemonFile', () => {
  it('writes under $DISPATCH_HOME/.dispatch/daemons and reads it back', () => {
    writeDaemonFile({
      rootDir,
      port: 4771,
      pid: process.pid,
      startedAt: '2026-07-19T00:00:00Z',
      agentToken: 'a'.repeat(64),
    });
    const path = daemonFilePath(rootDir);
    expect(path.startsWith(join(fakeHome, '.dispatch', 'daemons'))).toBe(true);
    expect(existsSync(path)).toBe(true);

    const info = readDaemonFile(rootDir);
    expect(info).toEqual({
      rootDir,
      port: 4771,
      pid: process.pid,
      startedAt: '2026-07-19T00:00:00Z',
      agentToken: 'a'.repeat(64),
    });
  });

  it('keys different rootDirs to different files', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    writeDaemonFile({
      rootDir,
      port: 1,
      pid: 1,
      startedAt: 't',
      agentToken: 'a',
    });
    writeDaemonFile({
      rootDir: otherRoot,
      port: 2,
      pid: 2,
      startedAt: 't',
      agentToken: 'a',
    });
    expect(daemonFilePath(rootDir)).not.toBe(daemonFilePath(otherRoot));
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it('treats an empty DISPATCH_HOME the same as unset (falls back to homedir())', () => {
    process.env.DISPATCH_HOME = '';
    expect(daemonFilePath(rootDir)).toBe(
      join(homedir(), '.dispatch', 'daemons', `${daemonFileKey(rootDir)}.json`)
    );
  });
});

describe('removeDaemonFile', () => {
  it('removes the file on clean shutdown, and is a no-op if already gone', () => {
    writeDaemonFile({
      rootDir,
      port: 1,
      pid: 1,
      startedAt: 't',
      agentToken: 'a',
    });
    expect(readDaemonFile(rootDir)).not.toBeNull();
    removeDaemonFile(rootDir, 1);
    expect(readDaemonFile(rootDir)).toBeNull();
    expect(() => removeDaemonFile(rootDir, 1)).not.toThrow();
  });

  it('leaves a file that a different daemon has since written', () => {
    writeDaemonFile({
      rootDir,
      port: 2,
      pid: 2,
      startedAt: 't',
      agentToken: 'b',
    });
    // The superseded daemon (pid 1) shuts down late; the file is not its.
    removeDaemonFile(rootDir, 1);
    expect(readDaemonFile(rootDir)?.pid).toBe(2);
  });

  it('defaults the owner to this process', () => {
    writeDaemonFile({
      rootDir,
      port: 3,
      pid: process.pid,
      startedAt: 't',
      agentToken: 'c',
    });
    removeDaemonFile(rootDir);
    expect(readDaemonFile(rootDir)).toBeNull();
  });
});

// Bun types `Server.port` as optional (unix-socket servers have none); every
// server here binds TCP, so an absent port is a test bug, not a case.
function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error('test server has no port');
  return server.port;
}

// The boot guard behind startServer: a second dispatchd on a root a live one
// still serves would force-fail that daemon's runs at reconcileOnBoot.
describe('assertRootNotServed', () => {
  // `process.ppid` (the test runner's parent) is a live pid that is not our
  // own — the guard exempts its own pid, since a daemon may legitimately find
  // its own file on disk.
  function writeFileFor(port: number, pid: number): void {
    writeDaemonFile({
      rootDir,
      port,
      pid,
      startedAt: '2026-09-07T14:39:02Z',
      agentToken: 'a'.repeat(64),
    });
  }

  it('is silent when no daemon file exists', async () => {
    await expect(assertRootNotServed(rootDir)).resolves.toBeUndefined();
  });

  it('refuses when the file names a live pid whose port answers health', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      writeFileFor(portOf(server), process.ppid);
      await expect(assertRootNotServed(rootDir)).rejects.toThrow(
        /already serving .* on port \d+/
      );
    } finally {
      await server.stop(true);
    }
  });

  it('refuses when the live pid merely stalls its health check — that is a busy daemon, not a dead one', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      writeFileFor(portOf(server), process.ppid);
      await expect(assertRootNotServed(rootDir, 100)).rejects.toThrow(
        new RegExp(`pid ${process.ppid}`)
      );
    } finally {
      await server.stop(true);
    }
  });

  it('treats a live pid whose port refuses as a stale file', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = portOf(server);
    await server.stop(true);
    writeFileFor(port, process.ppid);
    await expect(assertRootNotServed(rootDir)).resolves.toBeUndefined();
  });

  it('treats a dead pid as a stale file even when something answers on the port', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      writeFileFor(portOf(server), 999_999);
      await expect(assertRootNotServed(rootDir)).resolves.toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  it('never refuses on its own pid', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      writeFileFor(portOf(server), process.pid);
      await expect(assertRootNotServed(rootDir)).resolves.toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
