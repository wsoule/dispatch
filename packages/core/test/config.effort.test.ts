import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  isEffortLevel,
  loadConfig,
  updateConfig,
} from '../src/config.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-effort-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

describe('effort config', () => {
  it('is empty when the block is absent, so no effort is sent', () => {
    expect(loadConfig(root('autoCommit: true\n')).effort).toEqual({});
    expect(loadConfig(root()).effort).toEqual({});
  });

  it('reads each role it names and leaves the others unset', () => {
    const cfg = loadConfig(root('effort:\n  execute: xhigh\n  plan: low\n'));
    expect(cfg.effort).toEqual({ execute: 'xhigh', plan: 'low' });
  });

  it('throws a ConfigError on an unknown role', () => {
    const dir = root('effort:\n  draft: high\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/unknown effort role "draft"/);
  });

  it('throws a ConfigError on an unknown level', () => {
    const dir = root('effort:\n  execute: extreme\n');
    expect(() => loadConfig(dir)).toThrow(/effort\.execute must be one of/);
  });

  it('throws a ConfigError when the block is not an object', () => {
    expect(() => loadConfig(root('effort: high\n'))).toThrow(
      /effort must be an object/
    );
  });
});

describe('isEffortLevel', () => {
  it('accepts exactly the five SDK levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isEffortLevel(level)).toBe(true);
    }
    expect(isEffortLevel('HIGH')).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });
});

describe('updateConfig effort', () => {
  it('writes a role, and null removes it along with an emptied block', () => {
    const dir = root('autoCommit: true\n');
    updateConfig(dir, { effort: { execute: 'xhigh' } });
    expect(loadConfig(dir).effort).toEqual({ execute: 'xhigh' });

    updateConfig(dir, { effort: { execute: null } });
    expect(loadConfig(dir).effort).toEqual({});
    expect(
      readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8')
    ).not.toContain('effort');
  });

  it('refuses an unknown role or level before writing', () => {
    const dir = root('autoCommit: true\n');
    expect(() =>
      updateConfig(dir, { effort: { draft: 'high' } as never })
    ).toThrow(/invalid effort role: draft/);
    expect(() =>
      updateConfig(dir, { effort: { plan: 'extreme' as never } })
    ).toThrow(/invalid effort\.plan/);
    expect(loadConfig(dir).effort).toEqual({});
  });
});
