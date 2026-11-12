import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJoinLink } from '../src/login.js';
import type { SetupEnv } from '../src/setup.js';
import { clientHealth, connectClients } from '../src/setup.js';

// `dispatch-mcp status` says which clients reach Dispatch, and flags a
// config whose command is gone (a version manager removed the Node it
// named), instead of every hook failing silently (#237).

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-health-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function env(bins = ['claude', 'npx']): SetupEnv {
  return {
    home,
    platform: 'linux',
    node: '/x/node',
    has: (b) => bins.includes(b),
    run: () => 0,
  };
}

describe('client health', () => {
  it('reports Claude Code and its hooks as not connected before setup', () => {
    mkdirSync(join(home, '.claude'));
    expect(clientHealth(env())).toEqual([
      {
        client: 'Claude Code',
        state: 'not connected',
        detail: 'run `npx -y @dispatch-foo/mcp setup`',
      },
      expect.objectContaining({
        client: 'Claude Code hooks',
        state: 'not connected',
      }),
    ]);
  });

  it('reports connected when the configured command exists', () => {
    const launcher = join(home, 'launcher');
    writeFileSync(launcher, '');
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.cursor'));
    // What `claude mcp add -s user` would have written.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { dispatch: { command: launcher } } })
    );
    connectClients(env(), { command: launcher, args: [] });
    expect(clientHealth(env()).map((h) => [h.client, h.state])).toEqual([
      ['Claude Code', 'connected'],
      ['Claude Code hooks', 'connected'],
      ['Cursor', 'connected'],
    ]);
  });

  it('flags a config pinned to a Node that no longer exists', () => {
    const gone = '/home/x/.proto/tools/node/24.11.0/bin/node';
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.cursor'));
    connectClients(env(['npx']), { command: gone, args: ['/r/bin.js'] });
    const health = clientHealth(env(['npx']));
    expect(health.map((h) => [h.client, h.state])).toEqual([
      ['Codex', 'broken'],
      ['Cursor', 'broken'],
    ]);
    expect(health[0]?.detail).toContain('no longer exists');
  });

  it('counts npx as connected when npx is on PATH', () => {
    mkdirSync(join(home, '.cursor'));
    connectClients(env(['npx']), {
      command: 'npx',
      args: ['-y', '@dispatch-foo/mcp'],
    });
    expect(clientHealth(env(['npx']))).toEqual([
      { client: 'Cursor', state: 'connected' },
    ]);
  });
});

describe('invite links', () => {
  const token = 'tYej6F6VTCN5t-v3Ac0aUuuiMgwbz3Hpxf21rH-2Srg';
  it('reads the team service and the secret', () => {
    expect(parseJoinLink(`https://app.dispatch.foo/join/${token}`)).toEqual({
      server: 'https://app.dispatch.foo',
      token,
    });
    expect(parseJoinLink(`http://localhost:8787/join/${token}`)).toEqual({
      server: 'http://localhost:8787',
      token,
    });
  });

  it('refuses plain http to another machine', () => {
    expect(parseJoinLink(`http://evil.example/join/${token}`)).toHaveProperty(
      'error'
    );
  });

  it('points a project-team link at `dispatch team join`', () => {
    const payload = Buffer.from('{"v":1}').toString('base64url');
    for (const link of [
      `dispatch-team:${payload}`,
      `https://dispatch.foo/join#${payload}`,
    ])
      expect((parseJoinLink(link) as { error: string }).error).toContain(
        'dispatch team join'
      );
  });
});
