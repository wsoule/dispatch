import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, updateConfig } from '../src/config';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cfg-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('updateConfig', () => {
  test('sets a top-level value', () => {
    const dir = root('autoCommit: false\n');
    const cfg = updateConfig(dir, { verifyCommand: 'bun run verify' });
    expect(cfg.verifyCommand).toBe('bun run verify');
    expect(loadConfig(dir).verifyCommand).toBe('bun run verify');
  });

  test('sets a nested orchestrator value', () => {
    const dir = root('autoCommit: false\n');
    expect(
      updateConfig(dir, { epicConcurrency: 7 }).orchestrator.epicConcurrency
    ).toBe(7);
  });

  // The file is hand-written and checked in. Re-serialising a parsed object would silently
  // strip the comments and key order someone chose, which is why the document API is used.
  test('preserves comments and untouched keys', () => {
    const dir = root(
      '# how this project verifies\nautoCommit: true\n\n# statuses are structural\nstatuses:\n  - todo\n  - shipped\n'
    );
    updateConfig(dir, { verifyCommand: 'make check' });
    const text = read(dir);
    expect(text).toContain('# how this project verifies');
    expect(text).toContain('# statuses are structural');
    expect(text).toContain('shipped');
    expect(text).toContain('make check');
  });

  test('leaves statuses alone — they are not settings-editable', () => {
    const dir = root('statuses:\n  - todo\n  - shipped\n');
    const cfg = updateConfig(dir, { autoCommit: true });
    expect(cfg.statuses).toEqual(['todo', 'shipped']);
  });

  // An empty verify command and no verify command mean different things to the merge queue.
  test('clearing the verify command removes the key rather than blanking it', () => {
    const dir = root('verifyCommand: bun test\n');
    expect(
      updateConfig(dir, { verifyCommand: null }).verifyCommand
    ).toBeUndefined();
    expect(read(dir)).not.toContain('verifyCommand');
  });

  test('an all-whitespace verify command clears it too', () => {
    const dir = root('verifyCommand: bun test\n');
    expect(
      updateConfig(dir, { verifyCommand: '   ' }).verifyCommand
    ).toBeUndefined();
  });

  test('a verify command is trimmed', () => {
    const dir = root();
    expect(
      updateConfig(dir, { verifyCommand: '  bun test  ' }).verifyCommand
    ).toBe('bun test');
  });

  test('creates the file when the project has none', () => {
    const dir = root();
    expect(updateConfig(dir, { autoCommit: true }).autoCommit).toBe(true);
    expect(read(dir)).toContain('autoCommit');
  });

  test('an empty patch changes nothing', () => {
    const dir = root('autoCommit: true\nverifyCommand: bun test\n');
    const before = read(dir);
    updateConfig(dir, {});
    expect(read(dir)).toBe(before);
  });

  test.each([0, -1, 1.5])('rejects a nonsensical concurrency: %s', (value) => {
    expect(() => updateConfig(root(), { epicConcurrency: value })).toThrow(
      /positive integer/
    );
  });

  test('rejects a nonsensical verify timeout', () => {
    expect(() => updateConfig(root(), { verifyTimeoutSec: 0 })).toThrow(
      /positive integer/
    );
  });

  test('a rejected patch leaves the file untouched', () => {
    const dir = root('autoCommit: true\n');
    const before = read(dir);
    expect(() => updateConfig(dir, { epicConcurrency: -1 })).toThrow();
    expect(read(dir)).toBe(before);
  });

  test('several fields apply in one write', () => {
    const dir = root();
    const cfg = updateConfig(dir, {
      verifyCommand: 'bun run verify',
      autoCommit: true,
      epicConcurrency: 4,
      permissionMode: 'auto',
    });
    expect(cfg.verifyCommand).toBe('bun run verify');
    expect(cfg.autoCommit).toBe(true);
    expect(cfg.orchestrator.epicConcurrency).toBe(4);
  });

  test('round-trips through loadConfig', () => {
    const dir = root();
    updateConfig(dir, { epicConcurrency: 9, verifyTimeoutSec: 120 });
    const cfg = loadConfig(dir);
    expect(cfg.orchestrator.epicConcurrency).toBe(9);
    expect(cfg.orchestrator.verifyTimeoutSec).toBe(120);
  });
});
