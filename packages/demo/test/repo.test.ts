import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../src/git.js';
import { DEMO } from '../src/paths.js';
import { BRANCH_FIXES, buildRepo } from '../src/repo.js';

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-repo-'));
  buildRepo({ root, push: false });
  return root;
}

test('main carries the unfixed defects', () => {
  const root = build();
  const discount = readFileSync(join(root, 'src/checkout/discount.ts'), 'utf8');
  expect(discount).toContain('const known: Discount[]');
});

test('each in-review task has a branch whose diff is non-empty', () => {
  const root = build();
  for (const fix of BRANCH_FIXES) {
    const diff = git(root, 'diff', '--name-only', `main..${fix.branch}`);
    expect(diff.trim()).not.toBe('');
    expect(diff).toContain(fix.file);
  }
});

test('the working tree is left on main and clean', () => {
  const root = build();
  expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  expect(git(root, 'status', '--porcelain').trim()).toBe('');
});

test('the generated repo never contains a copied node_modules or bun.lock', () => {
  const root = build();
  expect(existsSync(join(root, 'node_modules'))).toBe(false);
  expect(existsSync(join(root, 'bun.lock'))).toBe(false);
});

test('buildRepo refuses to delete a root outside .agents/ignore and the temp dir', () => {
  expect(() => buildRepo({ root: '/tmp/../etc', push: false })).toThrow(
    /refusing to delete/
  );
  expect(() => buildRepo({ root: DEMO.repoRoot, push: false })).toThrow(
    /refusing to delete/
  );
});
