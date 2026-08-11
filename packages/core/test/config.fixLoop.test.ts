import { describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  DEFAULT_FIX_LOOP,
  loadConfig,
  updateConfig,
} from '../src/config.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-fixloop-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('fixLoop config', () => {
  it('defaults to DEFAULT_FIX_LOOP when the fixLoop block is absent', () => {
    const dir = root('autoCommit: true\n');
    expect(loadConfig(dir).fixLoop).toEqual(DEFAULT_FIX_LOOP);
  });

  it('a block on disk changes the cap and replaces the escalation table', () => {
    const dir = root(
      'fixLoop:\n' +
        '  cap: 3\n' +
        '  escalation:\n' +
        '    - round: 1\n' +
        '      strategy: fresh\n' +
        '      modelTier: high\n'
    );
    expect(loadConfig(dir).fixLoop).toEqual({
      auto: true,
      cap: 3,
      escalation: [{ round: 1, strategy: 'fresh', modelTier: 'high' }],
    });
  });

  it('cap alone keeps the default escalation table', () => {
    const dir = root('fixLoop:\n  cap: 2\n');
    expect(loadConfig(dir).fixLoop).toEqual({
      auto: true,
      cap: 2,
      escalation: DEFAULT_FIX_LOOP.escalation,
    });
  });

  it('auto defaults on and an explicit false turns it off', () => {
    expect(loadConfig(root('autoCommit: true\n')).fixLoop.auto).toBe(true);
    expect(loadConfig(root('fixLoop:\n  auto: false\n')).fixLoop.auto).toBe(
      false
    );
  });

  it('throws a ConfigError when auto is not a boolean', () => {
    const dir = root('fixLoop:\n  auto: sometimes\n');
    expect(() => loadConfig(dir)).toThrow(/fixLoop\.auto must be/);
  });

  test('updateConfig round-trips an auto change', () => {
    const dir = root('fixLoop:\n  cap: 5\n');
    const cfg = updateConfig(dir, { fixLoop: { auto: false } });
    expect(cfg.fixLoop.auto).toBe(false);
    expect(cfg.fixLoop.cap).toBe(5);
    expect(loadConfig(dir).fixLoop).toEqual(cfg.fixLoop);
  });

  it('throws a ConfigError on a bad escalation row', () => {
    const dir = root(
      'fixLoop:\n' +
        '  escalation:\n' +
        '    - round: 1\n' +
        '      strategy: sideways\n' +
        '      modelTier: high\n'
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/escalation\[0\]\.strategy/);
  });

  it('throws a ConfigError when cap is not a positive integer', () => {
    const dir = root('fixLoop:\n  cap: 0\n');
    expect(() => loadConfig(dir)).toThrow(/fixLoop\.cap must be/);
  });

  test('updateConfig round-trips a cap change, preserving comments and escalation', () => {
    const dir = root(
      '# how far the fix loop escalates\n' +
        'fixLoop:\n' +
        '  cap: 5\n' +
        '  escalation:\n' +
        '    - round: 1\n' +
        '      strategy: resume\n' +
        '      modelTier: standard\n'
    );

    const cfg = updateConfig(dir, { fixLoop: { cap: 2 } });

    expect(cfg.fixLoop.cap).toBe(2);
    expect(cfg.fixLoop.escalation).toEqual([
      { round: 1, strategy: 'resume', modelTier: 'standard' },
    ]);

    const text = read(dir);
    expect(text).toContain('# how far the fix loop escalates');
    expect(text).toContain('cap: 2');
    expect(loadConfig(dir).fixLoop).toEqual(cfg.fixLoop);
  });

  test('updateConfig round-trips an escalation table patch', () => {
    const dir = root('fixLoop:\n  cap: 5\n');
    const cfg = updateConfig(dir, {
      fixLoop: {
        escalation: [{ round: 1, strategy: 'fresh', modelTier: 'high' }],
      },
    });
    expect(cfg.fixLoop.escalation).toEqual([
      { round: 1, strategy: 'fresh', modelTier: 'high' },
    ]);
    expect(loadConfig(dir).fixLoop).toEqual(cfg.fixLoop);
  });

  test('rejects a bad escalation row in a patch before writing anything', () => {
    const dir = root('autoCommit: true\n');
    const before = read(dir);
    expect(() =>
      updateConfig(dir, {
        fixLoop: {
          escalation: [{ round: 1, strategy: 'sideways', modelTier: 'high' }],
        } as never,
      })
    ).toThrow(ConfigError);
    expect(read(dir)).toBe(before);
  });
});
