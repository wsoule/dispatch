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
