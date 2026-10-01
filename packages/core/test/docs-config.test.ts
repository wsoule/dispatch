import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_DOCS,
  parseDocsConfig,
  readDocsConfig,
} from '../src/docsConfig.js';

function rootWith(yaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-docs-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  if (yaml !== null) writeFileSync(join(root, '.dispatch', 'config.yml'), yaml);
  return root;
}

describe('docs config', () => {
  it('defaults every key', () => {
    expect(parseDocsConfig(undefined)).toEqual({
      config: DEFAULT_DOCS,
      warnings: [],
    });
    expect(DEFAULT_DOCS).toEqual({
      indexTokens: 400,
      inlineSpecBytes: 16384,
      coalesceMinutes: 10,
      noticeMinutes: 10,
      createsPerHour: 20,
      proposalsPerHour: 10,
      maxOpenProposals: 50,
      proposalTtlDays: 14,
    });
  });

  it('falls back per key with a warning instead of throwing', () => {
    const { config, warnings } = parseDocsConfig({
      indexTokens: 5000,
      coalesceMinutes: 0,
      noticeMinutes: 'soon',
      bogus: 1,
    });
    expect(config.indexTokens).toBe(400);
    expect(config.coalesceMinutes).toBe(0);
    expect(config.noticeMinutes).toBe(10);
    expect(warnings.map((w) => w.key)).toEqual([
      'indexTokens',
      'noticeMinutes',
      'bogus',
    ]);
  });

  it('reads the docs block per use and survives a config.yml that does not parse', () => {
    expect(
      readDocsConfig(rootWith('docs:\n  indexTokens: 800\n')).config.indexTokens
    ).toBe(800);
    expect(readDocsConfig(rootWith(null)).config).toEqual(DEFAULT_DOCS);
    const broken = readDocsConfig(rootWith('docs: [unclosed\n'));
    expect(broken.config).toEqual(DEFAULT_DOCS);
    expect(broken.warnings[0].key).toBe('docs');
  });

  it('treats inherited object keys as unknown settings', () => {
    const { config, warnings } = parseDocsConfig({
      toString: 5,
      constructor: 1,
    });
    expect(config).toEqual(DEFAULT_DOCS);
    expect(warnings.map((w) => w.key)).toEqual(['toString', 'constructor']);
  });

  it('warns on a non-object block', () => {
    expect(parseDocsConfig(3).warnings).toEqual([
      { key: 'docs', message: 'docs must be an object; using defaults' },
    ]);
  });
});
