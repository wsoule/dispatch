import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isStandalone, selfLaunch, stripScriptArg } from '../src/self.js';
import type { SetupEnv } from '../src/setup.js';
import { installRuntime, launcherPath, launcherScript } from '../src/setup.js';

// The desktop app bundles dispatch-mcp as a `bun build --compile` executable.
// Started as `<executable> <script> hub` it used to read the script path as
// the command, serve MCP on a closed stdin and exit 0, so the machine hub
// never came up (#237, item 5).

describe('starting this program again', () => {
  it('knows a compiled executable by its embedded module URL', () => {
    expect(isStandalone('file:///$bunfs/root/dispatch-mcp')).toBe(true);
    expect(isStandalone('file:///B:/~BUN/root/dispatch-mcp.exe')).toBe(true);
    expect(isStandalone('file:///opt/x/node_modules/a/dist/bin.js')).toBe(
      false
    );
  });

  it('starts a compiled executable with no script argument', () => {
    expect(
      selfLaunch('file:///$bunfs/root/dispatch-mcp', '/Apps/D/dispatch-mcp')
    ).toEqual({ command: '/Apps/D/dispatch-mcp', args: [] });
  });

  it('starts a script with the interpreter and its entry point', () => {
    const launch = selfLaunch(
      new URL('../src/endpoint.ts', import.meta.url).href,
      '/usr/bin/node'
    );
    expect(launch?.command).toBe('/usr/bin/node');
    expect(launch?.args[0]).toMatch(/src[\\/]bin\.ts$/);
  });

  it('drops a stale script argument only in a compiled executable', () => {
    const stale = ['/h/.dispatch/runtime/node_modules/x/dist/bin.js', 'hub'];
    expect(stripScriptArg(stale, true)).toEqual(['hub']);
    expect(stripScriptArg(stale, false)).toEqual(stale);
    expect(stripScriptArg(['hub'], true)).toEqual(['hub']);
    expect(stripScriptArg(['--root', '/x'], true)).toEqual(['--root', '/x']);
  });
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-launch-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function env(over: Partial<SetupEnv> = {}): SetupEnv & { ran: string[][] } {
  const ran: string[][] = [];
  return {
    ran,
    home,
    platform: 'linux',
    node: '/gone/node/24.11.0/bin/node',
    has: (b) => b === 'npm',
    run: (command, args) => {
      ran.push([command, ...args]);
      if (command === 'npm') {
        const bin = join(
          home,
          '.dispatch/runtime/node_modules/@dispatch-foo/mcp/dist/bin.js'
        );
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(bin, '');
      }
      return 0;
    },
    ...over,
  };
}

describe('the launch setup writes', () => {
  it('uses the desktop app executable directly once it answers --version', () => {
    const e = env({ standalone: '/Apps/Dispatch.app/R/dispatch-mcp' });
    expect(installRuntime(e, '0.27.0')).toEqual({
      command: '/Apps/Dispatch.app/R/dispatch-mcp',
      args: [],
    });
    expect(e.ran).toEqual([['/Apps/Dispatch.app/R/dispatch-mcp', '--version']]);
  });

  it('falls back to the runtime when the app executable does not run', () => {
    const e = env({
      standalone: '/Apps/D/dispatch-mcp',
      run: (command, args) => {
        if (command === '/Apps/D/dispatch-mcp') return 1;
        return env().run(command, args);
      },
    });
    expect(installRuntime(e, '0.27.0').command).toBe(launcherPath(e));
  });

  it('writes a launcher that does not pin the Node that ran setup', () => {
    const e = env();
    const launch = installRuntime(e, '0.27.0');
    expect(launch).toEqual({ command: launcherPath(e), args: [] });
    expect(e.ran.at(-1)).toEqual([launcherPath(e), '--version']);
    expect(readFileSync(launcherPath(e), 'utf8')).toBe(launcherScript(e));
  });

  it('keeps node + script on Windows, which has no sh', () => {
    const e = env({ platform: 'win32' });
    const launch = installRuntime(e, '0.27.0');
    expect(launch.command).toBe('/gone/node/24.11.0/bin/node');
  });

  it('runs the installed script with the first Node it finds', () => {
    const e = env();
    installRuntime(e, '0.27.0');
    // A stand-in for node that echoes what it was asked to run.
    const fake = join(home, 'fake-node');
    writeFileSync(fake, '#!/bin/sh\necho "ran $*"\n');
    chmodSync(fake, 0o755);
    const out = spawnSync(launcherPath(e), ['hub'], {
      encoding: 'utf8',
      env: { PATH: '/nonexistent', HOME: home, DISPATCH_NODE: fake },
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('dist/bin.js hub');
  });

  it('says so on stderr when there is no Node at all', () => {
    const e = env();
    installRuntime(e, '0.27.0');
    const out = spawnSync('/bin/sh', [launcherPath(e), 'hub'], {
      encoding: 'utf8',
      env: { PATH: '/nonexistent', HOME: home },
    });
    // /usr/bin/node may exist on the test machine; only assert the
    // no-Node branch when it does not.
    if (out.status === 127) expect(out.stderr).toContain('no Node.js found');
    else expect(out.status).not.toBe(126);
  });
});
