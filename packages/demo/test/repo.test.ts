import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { git } from '../src/git.js';
import { DEMO } from '../src/paths.js';
import { BRANCH_FIXES, buildRepo, skipInstallArtifacts } from '../src/repo.js';

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

test('skipInstallArtifacts drops a planted node_modules and bun.lock while keeping real files', () => {
  // Lay out a synthetic source tree with real content plus fake install
  // artifacts, so this proves the filter itself works rather than passing
  // vacuously because storefront-src happens not to have node_modules yet.
  const source = mkdtempSync(join(tmpdir(), 'demo-filter-src-'));
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src', 'keep.ts'), 'export const keep = true;\n');
  mkdirSync(join(source, 'node_modules', 'some-dep'), { recursive: true });
  writeFileSync(
    join(source, 'node_modules', 'some-dep', 'index.js'),
    'module.exports = {};\n'
  );
  writeFileSync(join(source, 'bun.lock'), '{}\n');

  const dest = mkdtempSync(join(tmpdir(), 'demo-filter-dest-'));
  cpSync(source, dest, { recursive: true, filter: skipInstallArtifacts });

  expect(readFileSync(join(dest, 'src', 'keep.ts'), 'utf8')).toBe(
    'export const keep = true;\n'
  );
  expect(existsSync(join(dest, 'node_modules'))).toBe(false);
  expect(existsSync(join(dest, 'bun.lock'))).toBe(false);
});

test('buildRepo refuses to delete a root outside .agents/ignore and the temp dir', () => {
  expect(() => buildRepo({ root: '/tmp/../etc', push: false })).toThrow(
    /refusing to delete/
  );
  expect(() => buildRepo({ root: DEMO.repoRoot, push: false })).toThrow(
    /refusing to delete/
  );
});

test('buildRepo accepts a root reached through a symlinked ancestor (mirrors macOS /var -> /private/var)', () => {
  // Fabricate a symlink hop under the OS temp dir so this test proves the
  // guard's realpath resolution regardless of whether the host's own
  // tmpdir() happens to be reached through a symlink.
  const base = mkdtempSync(join(tmpdir(), 'demo-guard-'));
  const real = join(base, 'real');
  mkdirSync(real);
  const link = join(base, 'link');
  symlinkSync(real, link);
  const root = join(link, 'repo');

  // Confirm this actually exercises a symlink hop and isn't a no-op path —
  // otherwise the non-throw assertion below would prove nothing.
  expect(realpathSync(link)).not.toBe(link);

  expect(() => buildRepo({ root, push: false })).not.toThrow();
});

// On macOS, os.tmpdir() returns a /var/folders/... path, but /var is a
// symlink to /private/var — so the "real" and "as-reported" forms of the OS
// temp dir differ textually while naming the same directory. Skip on hosts
// where that isn't true, since there'd be nothing distinct left to prove.
const tmpdirHasSymlinkHop = realpathSync(tmpdir()) !== resolve(tmpdir());

test.skipIf(!tmpdirHasSymlinkHop)(
  'buildRepo accepts a temp root already given in realpath form, even when tmpdir() itself is reached through a symlink',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'demo-repo-'));
    const realRoot = realpathSync(root);
    expect(realRoot).not.toBe(root);

    expect(() => buildRepo({ root: realRoot, push: false })).not.toThrow();
  }
);
