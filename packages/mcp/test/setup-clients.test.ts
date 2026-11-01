import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Launch, SetupEnv } from '../src/setup.js';
import {
  claudeHooks,
  commandLine,
  connectClients,
  installRuntime,
  safeToOpen,
} from '../src/setup.js';

// `setup` points every client at one absolute launch, updates what it wrote
// before, and never clobbers anything it did not write.

let home: string;
let ran: string[][];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-setup-home-'));
  ran = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function env(
  binaries: string[],
  status: (args: string[]) => number = () => 0
): SetupEnv {
  return {
    home,
    platform: 'linux',
    node: '/opt/node/bin/node',
    has: (b) => binaries.includes(b),
    run: (command, args) => {
      ran.push([command, ...args]);
      return status([command, ...args]);
    },
  };
}

const launch = (): Launch => ({
  command: '/opt/node/bin/node',
  args: [
    join(home, '.dispatch/runtime/node_modules/@dispatch-foo/mcp/dist/bin.js'),
  ],
});
const json = (path: string) =>
  JSON.parse(readFileSync(join(home, path), 'utf8')) as Record<string, unknown>;
const dir = (path: string) => mkdirSync(join(home, path), { recursive: true });

describe('setup', () => {
  it('connects every client it finds to one absolute launch', () => {
    for (const d of [
      '.cursor',
      '.codex',
      '.gemini',
      '.config/Claude',
      '.codeium/windsurf',
    ])
      dir(d);
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    );
    const l = launch();
    const results = connectClients(
      env(['claude'], (a) => (a.includes('remove') ? 1 : 0)),
      l
    );
    expect(results.map((r) => `${r.client}:${r.status}`)).toEqual([
      'Claude Code:added',
      'Claude Code hooks:added',
      'Codex:added',
      'Cursor:added',
      'Gemini CLI:added',
      'Claude Desktop:added',
      'Windsurf:added',
    ]);
    expect(ran.at(-1)).toEqual([
      'claude',
      'mcp',
      'add',
      '-s',
      'user',
      'dispatch',
      '--',
      l.command,
      ...l.args,
    ]);
    expect(json('.cursor/mcp.json').mcpServers).toEqual({
      other: { command: 'x' },
      dispatch: l,
    });
    expect(
      json('.config/Claude/claude_desktop_config.json').mcpServers
    ).toEqual({ 'dispatch-foo': l });
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      `model = "gpt-5"\n\n[mcp_servers.dispatch]\ncommand = "${l.command}"\nargs = ["${l.args[0]}"]\n`
    );
    expect(JSON.stringify(json('.claude/settings.json').hooks)).toContain(
      `${l.args[0]} hook claude wait`
    );
  });

  it('changes nothing on a second run with the same launch', () => {
    dir('.cursor');
    dir('.codex');
    dir('.claude');
    connectClients(env(['claude']), launch());
    const statuses = connectClients(env(['claude']), launch()).map(
      (r) => `${r.client}:${r.status}`
    );
    expect(statuses).toEqual([
      'Claude Code:updated',
      'Claude Code hooks:present',
      'Codex:present',
      'Cursor:present',
    ]);
  });

  it('moves what an earlier setup wrote to the new launch, keeping everything else', () => {
    dir('.cursor');
    dir('.codex');
    dir('.claude');
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { dispatch: { command: 'dispatch-mcp', args: [] } },
      })
    );
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      'model = "x"\n\n[mcp_servers.dispatch]\ncommand = "dispatch-mcp"\nargs = []\n\n[profiles.fast]\nmodel = "y"\n'
    );
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'say done' }] },
            ...claudeHooks({ command: 'dispatch-mcp', args: [] }).Stop,
          ],
          UserPromptSubmit: claudeHooks({ command: 'dispatch-mcp', args: [] })
            .UserPromptSubmit,
        },
      })
    );
    const l = launch();
    const results = connectClients(env(['claude']), l);
    expect(results.map((r) => r.status)).toEqual([
      'updated',
      'updated',
      'updated',
      'updated',
    ]);
    expect(json('.cursor/mcp.json').mcpServers).toEqual({ dispatch: l });
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain(`command = "${l.command}"`);
    expect(toml).not.toContain('dispatch-mcp');
    expect(toml).toContain('[profiles.fast]\nmodel = "y"');
    const settings = json('.claude/settings.json');
    expect(settings.model).toBe('opus');
    const text = JSON.stringify(settings.hooks);
    expect(text).toContain('say done');
    expect(text).not.toContain('"dispatch-mcp hook');
    expect((settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  });

  it('never replaces a different server someone named dispatch, or a config it cannot read', () => {
    dir('.cursor');
    dir('.gemini');
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { dispatch: { command: 'my-own' } } })
    );
    writeFileSync(join(home, '.gemini', 'settings.json'), '{ // comment\n}');
    const results = connectClients(env([]), launch());
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(json('.cursor/mcp.json').mcpServers).toEqual({
      dispatch: { command: 'my-own' },
    });
  });

  it('moves its old Claude Desktop entry off the name Claude reserves', () => {
    dir('.config/Claude');
    const path = '.config/Claude/claude_desktop_config.json';
    const l = launch();
    writeFileSync(
      join(home, path),
      JSON.stringify({
        mcpServers: { other: { command: 'x' }, dispatch: l },
      })
    );
    expect(connectClients(env([]), l).map((r) => r.status)).toEqual([
      'updated',
    ]);
    expect(json(path).mcpServers).toEqual({
      other: { command: 'x' },
      'dispatch-foo': l,
    });
    expect(connectClients(env([]), l).map((r) => r.status)).toEqual([
      'present',
    ]);

    writeFileSync(
      join(home, path),
      JSON.stringify({ mcpServers: { dispatch: { command: 'my-own' } } })
    );
    connectClients(env([]), l);
    expect(json(path).mcpServers).toEqual({
      dispatch: { command: 'my-own' },
      'dispatch-foo': l,
    });
  });

  it('keeps a config file’s own permissions', () => {
    dir('.cursor');
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{}');
    chmodSync(join(home, '.cursor', 'mcp.json'), 0o600);
    connectClients(env([]), launch());
    expect(statSync(join(home, '.cursor', 'mcp.json')).mode & 0o777).toBe(
      0o600
    );
  });
});

describe('runtime install', () => {
  it('installs the pinned version into ~/.dispatch/runtime and launches it with this node', () => {
    const bin = join(
      home,
      '.dispatch/runtime/node_modules/@dispatch-foo/mcp/dist/bin.js'
    );
    const e = env(['npm'], (args) => {
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '');
      return args[0] === 'npm' ? 0 : 1;
    });
    expect(installRuntime(e, '0.26.1')).toEqual({
      command: '/opt/node/bin/node',
      args: [bin],
    });
    expect(ran[0]).toEqual([
      'npm',
      'install',
      '--prefix',
      join(home, '.dispatch/runtime'),
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '@dispatch-foo/mcp@0.26.1',
    ]);
  });

  it('falls back to npx without npm, or when the install fails', () => {
    expect(installRuntime(env([]), '0.26.1')).toEqual({
      command: 'npx',
      args: ['-y', '@dispatch-foo/mcp@0.26.1'],
    });
    expect(
      installRuntime(
        env(['npm'], () => 1),
        '0.26.1'
      ).command
    ).toBe('npx');
  });

  it('quotes paths with spaces in hook commands', () => {
    expect(
      commandLine({ command: '/Apps/My Node/node', args: ['/x/bin.js'] }, [
        'hook',
        'claude',
        'Stop',
      ])
    ).toBe("'/Apps/My Node/node' /x/bin.js hook claude Stop");
  });
});

describe('opening the browser', () => {
  it('opens only https URLs on the team server', () => {
    expect(
      safeToOpen(
        'https://app.dispatch.foo/device?code=AB',
        'https://app.dispatch.foo'
      )
    ).toBe(true);
    expect(
      safeToOpen('https://evil.example/device', 'https://app.dispatch.foo')
    ).toBe(false);
    expect(
      safeToOpen('http://app.dispatch.foo/device', 'http://app.dispatch.foo')
    ).toBe(false);
    expect(
      safeToOpen('http://localhost:9000/device', 'http://localhost:9000')
    ).toBe(true);
    expect(safeToOpen('file:///etc/passwd', 'https://app.dispatch.foo')).toBe(
      false
    );
  });
});
