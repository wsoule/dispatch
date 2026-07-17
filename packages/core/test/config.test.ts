import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dispatch-')); });

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    expect(loadConfig(root)).toEqual({
      statuses: ['backlog', 'todo', 'in-progress', 'in-review', 'done', 'cancelled'],
      autoCommit: false,
    });
  });
  it('merges file values over defaults', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n');
    const cfg = loadConfig(root);
    expect(cfg.autoCommit).toBe(true);
    expect(cfg.statuses).toHaveLength(6);
  });
  it('mutating a returned config does not poison later loads', () => {
    loadConfig(root).statuses.push('x');
    expect(loadConfig(root).statuses).toEqual([
      'backlog', 'todo', 'in-progress', 'in-review', 'done', 'cancelled',
    ]);
  });
  it('throws a ConfigError on malformed YAML', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n  bad: x');
    expect(() => loadConfig(root)).toThrow(/invalid \.dispatch\/config\.yml/);
    let caught: unknown;
    try {
      loadConfig(root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
  });
  it('throws when statuses is not an array of strings', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: not-an-array\n');
    expect(() => loadConfig(root)).toThrow(/statuses must be/);
  });
  it('throws when autoCommit is not a boolean', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: "yes"\n');
    expect(() => loadConfig(root)).toThrow(/autoCommit must be/);
  });
});
