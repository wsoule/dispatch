import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  parseMemoryConfig,
  readMemoryConfig,
  updateConfig,
} from '../src/config.js';
import { DEFAULT_MEMORY } from '../src/configTypes.js';

function rootWith(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-mem-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'config.yml'), yaml);
  return root;
}

describe('memory config', () => {
  it('defaults every key, with claudeAutoMemory off until the probe passes', () => {
    expect(parseMemoryConfig(undefined)).toEqual({
      config: DEFAULT_MEMORY,
      warnings: [],
    });
    expect(DEFAULT_MEMORY.claudeAutoMemory).toBe('off');
    expect(loadConfig(rootWith('')).memory).toEqual(DEFAULT_MEMORY);
  });

  it('takes valid values', () => {
    const { config, warnings } = parseMemoryConfig({
      indexTokens: 2000,
      claudeAutoMemory: 'export',
      staleAfterDays: 30,
      retireAfterDays: 90,
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      ...DEFAULT_MEMORY,
      indexTokens: 2000,
      claudeAutoMemory: 'export',
      staleAfterDays: 30,
      retireAfterDays: 90,
    });
  });

  it('falls back per key with a warning naming it, never throwing', () => {
    const { config, warnings } = parseMemoryConfig({
      indexTokens: 50,
      proposalsPerHour: 2.5,
      claudeAutoMemory: 'yes',
      staleAfterDays: 100,
      retireAfterDays: 100,
    });
    expect(config.indexTokens).toBe(1000);
    expect(config.proposalsPerHour).toBe(10);
    expect(config.claudeAutoMemory).toBe('off');
    // Must be above staleAfterDays (100).
    expect(config.retireAfterDays).toBe(180);
    expect(warnings.map((w) => w.key).sort()).toEqual([
      'memory.claudeAutoMemory',
      'memory.indexTokens',
      'memory.proposalsPerHour',
      'memory.retireAfterDays',
    ]);
  });

  it('warns on a non-object block and keeps every default', () => {
    expect(parseMemoryConfig('nope')).toEqual({
      config: DEFAULT_MEMORY,
      warnings: [
        { key: 'memory', message: 'memory must be a mapping; using defaults' },
      ],
    });
  });

  it('reads the memory block even when another block is invalid', () => {
    const root = rootWith(
      'messaging:\n  urgentPerHour: 0\nmemory:\n  indexTokens: 1500\n'
    );
    expect(() => loadConfig(root)).toThrow(/messaging.urgentPerHour/);
    expect(readMemoryConfig(root).config.indexTokens).toBe(1500);
  });

  it('reads defaults and a warning when config.yml is not YAML', () => {
    const { config, warnings } = readMemoryConfig(
      rootWith('memory: [unclosed')
    );
    expect(config).toEqual(DEFAULT_MEMORY);
    expect(warnings[0].key).toBe('memory');
  });

  it('patches memory keys and refuses an invalid patch', () => {
    const root = rootWith('');
    updateConfig(root, {
      memory: { indexTokens: 1200, claudeAutoMemory: 'export' },
    });
    expect(readMemoryConfig(root).config).toMatchObject({
      indexTokens: 1200,
      claudeAutoMemory: 'export',
    });
    expect(() => updateConfig(root, { memory: { indexTokens: 10 } })).toThrow(
      /memory.indexTokens/
    );
    updateConfig(root, { memory: { indexTokens: null } });
    expect(
      readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8')
    ).not.toContain('indexTokens');
  });
});
