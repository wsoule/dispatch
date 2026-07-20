import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

import { daemonFilePath, readDaemonFile } from '../src/daemon.js';

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-daemon-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('readDaemonFile', () => {
  it('returns null instead of throwing when the daemon file is corrupt JSON', () => {
    const rootDir = '/some/project';
    const path = daemonFilePath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    // A crash mid-write: truncated, unparsable JSON.
    writeFileSync(path, '{"port": 4000, "pid":');

    expect(() => readDaemonFile(rootDir)).not.toThrow();
    expect(readDaemonFile(rootDir)).toBeNull();
  });

  it('returns the parsed info for a valid daemon file', () => {
    const rootDir = '/some/other/project';
    const path = daemonFilePath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        port: 4000,
        pid: 1234,
        rootDir,
        startedAt: '2026-07-20T00:00:00.000Z',
      })
    );

    expect(readDaemonFile(rootDir)).toEqual({
      port: 4000,
      pid: 1234,
      rootDir,
      startedAt: '2026-07-20T00:00:00.000Z',
    });
  });
});
