import { describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  DEFAULT_MODELS,
  loadConfig,
  updateConfig,
} from '../src/config.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-models-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('models config', () => {
  it('defaults to DEFAULT_MODELS when the models block is absent', () => {
    const dir = root('autoCommit: true\n');
    expect(loadConfig(dir).models).toEqual(DEFAULT_MODELS);
  });

  it('merges a partial models block over the defaults, leaving the rest untouched', () => {
    const dir = root('models:\n  execute: claude-opus-4-8\n');
    const cfg = loadConfig(dir);
    expect(cfg.models.execute).toBe('claude-opus-4-8');
    // Every role not mentioned keeps its DEFAULT_MODELS value.
    expect(cfg.models.plan).toBe(DEFAULT_MODELS.plan);
    expect(cfg.models.draft).toBe(DEFAULT_MODELS.draft);
    expect(cfg.models.enrich).toBe(DEFAULT_MODELS.enrich);
    expect(cfg.models.cluster).toBe(DEFAULT_MODELS.cluster);
    expect(cfg.models.summarize).toBe(DEFAULT_MODELS.summarize);
  });

  it('throws a ConfigError on an unknown role key', () => {
    const dir = root('models:\n  excute: claude-opus-5\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/unknown models role "excute"/);
  });

  it('throws a ConfigError when a role value is not a string', () => {
    const dir = root('models:\n  execute: 5\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/models\.execute must be/);
  });

  it('throws a ConfigError when a role value is an empty string', () => {
    const dir = root('models:\n  plan: ""\n');
    expect(() => loadConfig(dir)).toThrow(/models\.plan must be/);
  });

  test('updateConfig round-trips a single role without clobbering the others or dropping comments', () => {
    const dir = root(
      '# how this project routes agent work\n' +
        'models:\n' +
        '  execute: claude-opus-4-8\n' +
        '  plan: claude-sonnet-5\n' +
        '\n' +
        '# statuses are structural\n' +
        'statuses:\n' +
        '  - todo\n' +
        '  - shipped\n'
    );

    const cfg = updateConfig(dir, {
      models: { plan: 'claude-haiku-4-5-20251001' },
    });

    // The role that was patched changed...
    expect(cfg.models.plan).toBe('claude-haiku-4-5-20251001');
    // ...but every other role — set explicitly or left at its default — survived untouched.
    expect(cfg.models.execute).toBe('claude-opus-4-8');
    expect(cfg.models.draft).toBe(DEFAULT_MODELS.draft);
    expect(cfg.models.cluster).toBe(DEFAULT_MODELS.cluster);

    const text = read(dir);
    expect(text).toContain('# how this project routes agent work');
    expect(text).toContain('# statuses are structural');
    expect(text).toContain('claude-opus-4-8');
    expect(text).toContain('claude-haiku-4-5-20251001');
    expect(text).toContain('shipped');

    // Re-reading through loadConfig sees exactly what was just written.
    expect(loadConfig(dir).models).toEqual(cfg.models);
  });

  test('rejects an unknown role in a patch before writing anything', () => {
    const dir = root('autoCommit: true\n');
    const before = read(dir);
    expect(() =>
      updateConfig(dir, { models: { nope: 'claude-opus-5' } as never })
    ).toThrow(ConfigError);
    expect(read(dir)).toBe(before);
  });
});
