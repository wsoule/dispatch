import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-linear-config-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

describe('linear.teamIds', () => {
  it('reads a legacy teamId as a one-team list', () => {
    const linear = loadConfig(
      writeConfig('linear:\n  teamId: team-1\n')
    ).linear;
    expect(linear.teamIds).toEqual(['team-1']);
    expect(linear.teamId).toBe('team-1');
  });

  it('reads teamIds in order, the first as the primary, over a stale teamId', () => {
    const linear = loadConfig(
      writeConfig(
        'linear:\n  teamId: team-9\n  teamIds: [team-2, team-1, team-2]\n'
      )
    ).linear;
    expect(linear.teamIds).toEqual(['team-2', 'team-1']);
    expect(linear.teamId).toBe('team-2');
  });

  it('links no team by default', () => {
    const linear = loadConfig(writeConfig('')).linear;
    expect(linear.teamIds).toEqual([]);
    expect(linear.teamId).toBeNull();
  });

  it('writes both keys from either patch, so an older build still syncs', () => {
    const dir = writeConfig('');
    updateConfig(dir, { linear: { teamIds: ['team-1', 'team-2'] } });
    const file = readFileSync(join(dir, '.dispatch/config.yml'), 'utf8');
    expect(file).toContain('teamId: team-1');
    expect(loadConfig(dir).linear.teamIds).toEqual(['team-1', 'team-2']);

    updateConfig(dir, { linear: { teamId: 'team-3' } });
    expect(loadConfig(dir).linear.teamIds).toEqual(['team-3']);
    updateConfig(dir, { linear: { teamIds: [] } });
    expect(loadConfig(dir).linear).toMatchObject({
      teamIds: [],
      teamId: null,
    });
  });

  it('refuses a list that is not team ids', () => {
    expect(() =>
      loadConfig(writeConfig('linear:\n  teamIds: team-1\n'))
    ).toThrow(ConfigError);
    expect(() =>
      updateConfig(writeConfig(''), { linear: { teamIds: [''] } })
    ).toThrow(ConfigError);
  });
});

describe('linear.archiveFinished', () => {
  it('is off by default', () => {
    expect(loadConfig(writeConfig('')).linear.archiveFinished).toBe(false);
    const bare = mkdtempSync(join(tmpdir(), 'dispatch-linear-config-'));
    expect(loadConfig(bare).linear.archiveFinished).toBe(false);
  });

  it('reads archiveFinished from config.yml', () => {
    const linear = loadConfig(
      writeConfig('linear:\n  archiveFinished: true\n')
    ).linear;
    expect(linear.archiveFinished).toBe(true);
  });

  it('refuses a non-boolean archiveFinished', () => {
    expect(() =>
      loadConfig(writeConfig('linear:\n  archiveFinished: sometimes\n'))
    ).toThrow(ConfigError);
    const dir = writeConfig('linear:\n  enabled: true\n');
    const before = readFileSync(join(dir, '.dispatch/config.yml'), 'utf8');
    expect(() =>
      updateConfig(dir, { linear: { archiveFinished: 'true' as never } })
    ).toThrow(ConfigError);
    expect(readFileSync(join(dir, '.dispatch/config.yml'), 'utf8')).toBe(
      before
    );
  });

  it('round-trips archiveFinished through updateConfig and keeps the rest of the block', () => {
    const dir = writeConfig('linear:\n  enabled: true\n  teamId: team-1\n');
    updateConfig(dir, { linear: { archiveFinished: true } });
    const file = readFileSync(join(dir, '.dispatch/config.yml'), 'utf8');
    expect(file).toContain('archiveFinished: true');
    expect(loadConfig(dir).linear).toMatchObject({
      archiveFinished: true,
      enabled: true,
      teamIds: ['team-1'],
    });
    updateConfig(dir, { linear: { archiveFinished: false } });
    expect(loadConfig(dir).linear.archiveFinished).toBe(false);
  });
});

describe('linear sign-in keys', () => {
  it('defaults to no client ID and the 47823 callback port', () => {
    const { linear } = loadConfig(writeConfig(''));
    expect(linear.oauthClientId).toBeNull();
    expect(linear.oauthCallbackPort).toBe(47823);
  });

  it('reads oauthClientId and oauthCallbackPort from config.yml', () => {
    const { linear } = loadConfig(
      writeConfig(
        'linear:\n  oauthClientId: " abc123 "\n  oauthCallbackPort: 50123\n'
      )
    );
    expect(linear.oauthClientId).toBe('abc123');
    expect(linear.oauthCallbackPort).toBe(50123);
  });

  it('refuses a client ID with spaces or over 200 characters, and a bad port', () => {
    for (const body of [
      'linear:\n  oauthClientId: "two words"\n',
      `linear:\n  oauthClientId: ${'a'.repeat(201)}\n`,
      'linear:\n  oauthClientId: 7\n',
      'linear:\n  oauthCallbackPort: 80\n',
      'linear:\n  oauthCallbackPort: 70000\n',
      'linear:\n  oauthCallbackPort: 5000.5\n',
    ]) {
      expect(() => loadConfig(writeConfig(body))).toThrow(ConfigError);
    }
  });

  it('round-trips both keys through updateConfig and clears the client ID', () => {
    const dir = writeConfig('linear:\n  enabled: true\n');
    updateConfig(dir, {
      linear: { oauthClientId: 'client-xyz', oauthCallbackPort: 49000 },
    });
    const file = readFileSync(join(dir, '.dispatch/config.yml'), 'utf8');
    expect(file).toContain('oauthClientId: client-xyz');
    expect(file).toContain('oauthCallbackPort: 49000');
    expect(loadConfig(dir).linear.enabled).toBe(true);
    updateConfig(dir, { linear: { oauthClientId: null } });
    expect(loadConfig(dir).linear.oauthClientId).toBeNull();
    expect(() =>
      updateConfig(dir, { linear: { oauthCallbackPort: 22 } })
    ).toThrow(ConfigError);
    expect(() =>
      updateConfig(dir, { linear: { oauthClientId: 'has space' } })
    ).toThrow(ConfigError);
  });
});
