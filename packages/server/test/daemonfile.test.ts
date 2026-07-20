import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
    });
  });

  it('keys different rootDirs to different files', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    writeDaemonFile({ rootDir, port: 1, pid: 1, startedAt: 't' });
    writeDaemonFile({ rootDir: otherRoot, port: 2, pid: 2, startedAt: 't' });
    expect(daemonFilePath(rootDir)).not.toBe(daemonFilePath(otherRoot));
    rmSync(otherRoot, { recursive: true, force: true });
  });
});

describe('removeDaemonFile', () => {
  it('removes the file on clean shutdown, and is a no-op if already gone', () => {
    writeDaemonFile({ rootDir, port: 1, pid: 1, startedAt: 't' });
    expect(readDaemonFile(rootDir)).not.toBeNull();
    removeDaemonFile(rootDir);
    expect(readDaemonFile(rootDir)).toBeNull();
    expect(() => removeDaemonFile(rootDir)).not.toThrow();
  });
});
