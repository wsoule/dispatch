import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDaemonLauncher } from '../src/commands/daemon.js';

// The three-tier precedence resolveDaemonLauncher implements — see its doc
// comment: (a) DISPATCH_DAEMON_BIN override, (b) a compiled `dispatchd` binary
// sitting beside the running executable (packaged install), (c) the monorepo
// source entry via `bun` (dev).

const originalDaemonBin = process.env.DISPATCH_DAEMON_BIN;

beforeEach(() => {
  delete process.env.DISPATCH_DAEMON_BIN;
});

afterEach(() => {
  if (originalDaemonBin === undefined) delete process.env.DISPATCH_DAEMON_BIN;
  else process.env.DISPATCH_DAEMON_BIN = originalDaemonBin;
});

// Lays out a fake app Resources dir with the given executable basenames, each
// an empty file marked executable, and returns the dir. `dispatch-cli` stands
// in for the running executable (its path is what we pass as execPath).
function makeResourcesDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-launcher-'));
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, '');
    chmodSync(path, 0o755);
  }
  return dir;
}

describe('resolveDaemonLauncher precedence', () => {
  it('(a) DISPATCH_DAEMON_BIN override wins, even when a sibling binary exists', () => {
    // Sibling dispatchd is present, but the explicit override must still win.
    const dir = makeResourcesDir(['dispatchd', 'dispatch-cli']);
    process.env.DISPATCH_DAEMON_BIN = '/custom/dispatchd';

    const launcher = resolveDaemonLauncher(join(dir, 'dispatch-cli'));

    expect(launcher.cmd).toBe('/custom/dispatchd');
    expect(launcher.leadingArgs).toEqual([]);
    expect(launcher.usesBun).toBe(false);
    expect(launcher.env).toBeUndefined();
  });

  it('(a) a .ts/.js override runs through bun', () => {
    process.env.DISPATCH_DAEMON_BIN = '/repo/packages/server/src/bin.ts';

    const launcher = resolveDaemonLauncher('/anywhere/dispatch-cli');

    expect(launcher.cmd).toBe('bun');
    expect(launcher.leadingArgs).toEqual(['/repo/packages/server/src/bin.ts']);
    expect(launcher.usesBun).toBe(true);
  });

  it('(b) spawns a sibling compiled dispatchd directly and points at the sibling MCP', () => {
    const dir = makeResourcesDir(['dispatchd', 'dispatch-mcp', 'dispatch-cli']);

    const launcher = resolveDaemonLauncher(join(dir, 'dispatch-cli'));

    expect(launcher.cmd).toBe(join(dir, 'dispatchd'));
    expect(launcher.leadingArgs).toEqual([]);
    expect(launcher.usesBun).toBe(false);
    expect(launcher.env).toEqual({
      DISPATCH_MCP_BIN: join(dir, 'dispatch-mcp'),
    });
  });

  it('(b) omits DISPATCH_MCP_BIN when no sibling MCP binary is present', () => {
    const dir = makeResourcesDir(['dispatchd', 'dispatch-cli']);

    const launcher = resolveDaemonLauncher(join(dir, 'dispatch-cli'));

    expect(launcher.cmd).toBe(join(dir, 'dispatchd'));
    expect(launcher.env).toEqual({});
  });

  it('(c) falls back to the monorepo source entry via bun in dev', () => {
    // A temp dir with no `dispatchd` sibling forces the source fallback.
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-launcher-bare-'));

    const launcher = resolveDaemonLauncher(join(dir, 'dispatch-cli'));

    expect(launcher.cmd).toBe('bun');
    expect(launcher.leadingArgs).toHaveLength(1);
    expect(launcher.leadingArgs[0]).toMatch(/packages\/server\/src\/bin\.ts$/);
    expect(launcher.usesBun).toBe(true);
  });
});
