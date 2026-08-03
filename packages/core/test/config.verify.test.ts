import { describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-verify-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('verify config', () => {
  it('is undefined when the verify block is absent — the stage has nothing to dispatch', () => {
    const dir = root('autoCommit: true\n');
    expect(loadConfig(dir).verify).toBeUndefined();
  });

  it('parses every field of a full verify block', () => {
    const dir = root(
      'verify:\n' +
        '  command: bun run dev\n' +
        '  url: http://localhost:3000\n' +
        '  notes: log in as the seeded admin user\n'
    );
    expect(loadConfig(dir).verify).toEqual({
      command: 'bun run dev',
      url: 'http://localhost:3000',
      notes: 'log in as the seeded admin user',
    });
  });

  it('parses a partial verify block, leaving the other fields absent', () => {
    const dir = root('verify:\n  command: bun run dev\n');
    expect(loadConfig(dir).verify).toEqual({ command: 'bun run dev' });
  });

  it('throws a ConfigError on an unknown field', () => {
    const dir = root('verify:\n  commnad: bun run dev\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/unknown verify field "commnad"/);
  });

  it('throws a ConfigError when a field value is an empty string', () => {
    const dir = root('verify:\n  url: ""\n');
    expect(() => loadConfig(dir)).toThrow(/verify\.url must be/);
  });

  it('throws a ConfigError when the block is not an object', () => {
    const dir = root('verify: bun run dev\n');
    expect(() => loadConfig(dir)).toThrow(/verify must be an object/);
  });

  test('updateConfig round-trips a single field without clobbering the others', () => {
    const dir = root(
      '# how to exercise this project\n' +
        'verify:\n' +
        '  command: bun run dev\n' +
        '  url: http://localhost:3000\n'
    );

    const cfg = updateConfig(dir, { verify: { url: 'http://localhost:4000' } });

    expect(cfg.verify?.url).toBe('http://localhost:4000');
    expect(cfg.verify?.command).toBe('bun run dev');

    const text = read(dir);
    expect(text).toContain('# how to exercise this project');
    expect(text).toContain('bun run dev');
    expect(text).toContain('http://localhost:4000');
    expect(loadConfig(dir).verify).toEqual(cfg.verify);
  });

  test('rejects an unknown field in a patch before writing anything', () => {
    const dir = root('autoCommit: true\n');
    const before = read(dir);
    expect(() =>
      updateConfig(dir, { verify: { commnad: 'x' } as never })
    ).toThrow(ConfigError);
    expect(read(dir)).toBe(before);
  });
});
