import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

import {
  daemonFilePath,
  desktopAppCandidates,
  desktopAppInstalled,
  readDaemonFile,
  startDaemonAdvice,
} from '../src/daemon.js';

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

// The "dispatchd not running" errors used to say only "run: dispatch serve",
// which is no help to someone whose daemon comes from the desktop app and who
// may not have the CLI at all.
describe('startDaemonAdvice', () => {
  it('points at the desktop app when it is installed', () => {
    expect(startDaemonAdvice(true)).toMatch(/Dispatch desktop app/);
    expect(startDaemonAdvice(true)).toMatch(/dispatch serve/);
  });

  it('falls back to dispatch serve when the app is not installed', () => {
    expect(startDaemonAdvice(false)).toBe('Start it with: dispatch serve');
  });
});

describe('desktopAppInstalled', () => {
  it('finds the app bundle under the user Applications folder', () => {
    const [, userApp] = desktopAppCandidates('darwin', fakeHome);
    expect(userApp).toBe(join(fakeHome, 'Applications', 'Dispatch.app'));
    expect(desktopAppInstalled([userApp ?? ''])).toBe(false);
    mkdirSync(join(fakeHome, 'Applications', 'Dispatch.app'), {
      recursive: true,
    });
    expect(desktopAppInstalled([userApp ?? ''])).toBe(true);
  });

  it('looks nowhere off macOS', () => {
    expect(desktopAppCandidates('linux', fakeHome)).toEqual([]);
    expect(desktopAppInstalled([])).toBe(false);
  });
});
