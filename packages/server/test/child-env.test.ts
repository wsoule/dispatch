import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { childEnv } from '../src/childEnv.js';
import { spawnCodexAppServer } from '../src/orchestrator/codexAppServer.js';
import { experimentOptions } from '../src/orchestrator/executors/claude.js';
import { TerminalRegistry } from '../src/terminals.js';
import type { SpawnTerminalOptions } from '../src/terminals.js';

// The decide-tier token, and any other DISPATCH_*TOKEN* the daemon was handed,
// must never reach a shell or an agent it starts.
const SECRETS = {
  DISPATCH_APP_TOKEN: 'decide-tier',
  DISPATCH_AGENT_TOKEN: 'agent',
  DISPATCH_TEAM_TOKEN_X: 'team',
};
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('childEnv', () => {
  it('drops the app token and every DISPATCH_*TOKEN* but keeps the rest', () => {
    Object.assign(process.env, SECRETS, { DISPATCH_HOME: '/h', PATH: '/bin' });
    const env = childEnv({ EXTRA: '1' });
    for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
    expect(env).toMatchObject({
      DISPATCH_HOME: '/h',
      PATH: '/bin',
      EXTRA: '1',
    });
  });

  it('keeps tokens out of a terminal shell', () => {
    Object.assign(process.env, SECRETS);
    const dir = mkdtempSync(join(tmpdir(), 'child-env-'));
    process.env.DISPATCH_HOME = dir;
    let seen: SpawnTerminalOptions | null = null;
    try {
      const registry = new TerminalRegistry(dir, {
        spawn: (opts) => {
          seen = opts;
          throw new Error('not spawned');
        },
      });
      registry.create({ cwd: dir, command: ['true'] });
      expect(seen).not.toBeNull();
      for (const key of Object.keys(SECRETS))
        expect((seen as SpawnTerminalOptions | null)?.env[key]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps tokens out of a Claude run, with or without experiments', () => {
    Object.assign(process.env, SECRETS);
    for (const experiments of [[], ['cache-1h']] as const) {
      const env = experimentOptions([...experiments]).env ?? {};
      expect(Object.keys(env).length).toBeGreaterThan(0);
      for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
    }
  });

  it('keeps tokens out of the Codex app server', async () => {
    Object.assign(process.env, SECRETS, { PATH: `${process.env.PATH ?? ''}` });
    const dir = mkdtempSync(join(tmpdir(), 'child-env-codex-'));
    try {
      const child = spawnCodexAppServer(dir, 'env');
      let out = '';
      for await (const chunk of child.stdout) out += String(chunk);
      expect(out).toContain('PATH=');
      expect(out).not.toContain('DISPATCH_APP_TOKEN');
      expect(out).not.toContain('DISPATCH_AGENT_TOKEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
