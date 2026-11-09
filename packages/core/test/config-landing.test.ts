import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  fixLoopAutoEnabled,
  loadConfig,
  updateConfig,
} from '../src/config.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-landing-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

describe('landing config', () => {
  it('landing defaults to queue', () => {
    expect(loadConfig(root('autoCommit: true\n')).landing).toBe('queue');
    // No config.yml at all takes the same default.
    expect(loadConfig(root()).landing).toBe('queue');
  });

  it('landing: pr parses', () => {
    expect(loadConfig(root('landing: pr\n')).landing).toBe('pr');
    expect(loadConfig(root('landing: queue\n')).landing).toBe('queue');
  });

  it('invalid landing is rejected with a message naming the key', () => {
    const dir = root('landing: github\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/landing must be one of pr\|queue/);
  });

  it('updateConfig writes landing and refuses an unknown mode', () => {
    const dir = root('autoCommit: true\n');
    updateConfig(dir, { landing: 'pr' });
    expect(loadConfig(dir).landing).toBe('pr');
    expect(
      readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8')
    ).toContain('landing: pr');
    expect(() =>
      updateConfig(dir, { landing: 'github' as unknown as 'pr' })
    ).toThrow(/landing/);
    expect(loadConfig(dir).landing).toBe('pr');
  });
});

describe('fixLoopAutoEnabled', () => {
  it('fixLoopAutoEnabled is true for pr even with fixLoop.auto false', () => {
    const cfg = loadConfig(root('landing: pr\nfixLoop:\n  auto: false\n'));
    expect(cfg.fixLoop.auto).toBe(false);
    expect(fixLoopAutoEnabled(cfg)).toBe(true);
  });

  it('follows fixLoop.auto in queue mode', () => {
    expect(fixLoopAutoEnabled(loadConfig(root('landing: queue\n')))).toBe(
      false
    );
    expect(
      fixLoopAutoEnabled(loadConfig(root('fixLoop:\n  auto: true\n')))
    ).toBe(true);
  });
});
