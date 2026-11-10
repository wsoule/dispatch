import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';
import {
  DEFAULT_OVERSEER,
  OVERSEER_AUTONOMY_LEVELS,
  overseerAutonomy,
} from '../src/configTypes.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-overseer-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

describe('overseer config', () => {
  it('defaults to balanced when the block or the file is absent', () => {
    expect(loadConfig(root('autoCommit: true\n')).overseer).toEqual(
      DEFAULT_OVERSEER
    );
    const empty = mkdtempSync(join(tmpdir(), 'dispatch-overseer-'));
    expect(overseerAutonomy(loadConfig(empty))).toBe('balanced');
    expect(overseerAutonomy(loadConfig(root('overseer: {}\n')))).toBe(
      'balanced'
    );
  });

  it('reads every level off disk', () => {
    for (const level of OVERSEER_AUTONOMY_LEVELS) {
      const dir = root(`overseer:\n  autonomy: ${level}\n`);
      expect(overseerAutonomy(loadConfig(dir))).toBe(level);
    }
  });

  it('a hand-built config with no block reads as the default', () => {
    expect(overseerAutonomy({} as never)).toBe('balanced');
  });

  it('rejects an unknown level or a malformed block', () => {
    expect(() => loadConfig(root('overseer:\n  autonomy: reckless\n'))).toThrow(
      ConfigError
    );
    expect(() => loadConfig(root('overseer: yes\n'))).toThrow(ConfigError);
  });

  it('updateConfig writes the level and null clears it', () => {
    const dir = root('autoCommit: false\n');
    expect(
      updateConfig(dir, { overseer: { autonomy: 'trusting' } }).overseer
    ).toEqual({ stream: 'live', autonomy: 'trusting' });
    expect(
      readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8')
    ).toContain('autonomy: trusting');
    expect(
      updateConfig(dir, { overseer: { autonomy: null } }).overseer
    ).toEqual(DEFAULT_OVERSEER);
  });

  it('updateConfig refuses a level the loader would refuse', () => {
    const dir = root('autoCommit: false\n');
    expect(() =>
      updateConfig(dir, { overseer: { autonomy: 'yolo' as never } })
    ).toThrow(ConfigError);
  });
});
