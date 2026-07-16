import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

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
});
