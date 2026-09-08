import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
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
  it('leaves a file written by a different daemon in place', () => {
    const otherPid = process.pid + 100_000;
    writeDaemonFile({
      rootDir,
      port: 4242,
      pid: otherPid,
      startedAt: '2026-08-23T13:15:00Z',
      agentToken: 'b'.repeat(64),
    });
    // A late shutdown from a previous daemon must not erase its successor's
    // record — the app already started the replacement.
    removeDaemonFile(rootDir);
    expect(existsSync(daemonFilePath(rootDir))).toBe(true);
    // The daemon the file names may.
    removeDaemonFile(rootDir, otherPid);
    expect(existsSync(daemonFilePath(rootDir))).toBe(false);
  });

  it('removes a file it cannot parse, since nothing owns it', () => {
    const path = daemonFilePath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    removeDaemonFile(rootDir);
    expect(existsSync(path)).toBe(false);
  });

  it('removes the file on clean shutdown, and is a no-op if already gone', () => {
    writeDaemonFile({
      rootDir,
      port: 1,
      pid: process.pid,
      startedAt: 't',
      agentToken: 'a',
    });
    expect(readDaemonFile(rootDir)).not.toBeNull();
    removeDaemonFile(rootDir);
    expect(readDaemonFile(rootDir)).toBeNull();
    expect(() => removeDaemonFile(rootDir)).not.toThrow();
  });
});
