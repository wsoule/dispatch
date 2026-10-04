import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../src/git.js';
import { resetDemo } from '../src/reset.js';

describe('resetDemo --no-push', () => {
  test('builds both clones offline, the teammate cloned from the local repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-reset-'));
    try {
      const paths = {
        root: join(dir, 'storefront'),
        home: join(dir, 'storefront-home'),
        teammateRoot: join(dir, 'teammate', 'storefront'),
        teammateHome: join(dir, 'teammate', 'home'),
        // Unreachable: any push or clone from here would fail the reset.
        remote: join(dir, 'no-such-remote.git'),
      };
      resetDemo({ push: false, paths, log: () => {} });
      expect(existsSync(join(paths.root, '.git'))).toBe(true);
      expect(existsSync(join(paths.teammateRoot, '.git'))).toBe(true);
      expect(
        git(paths.teammateRoot, 'remote', 'get-url', 'origin').trim()
      ).toBe(paths.root);
      expect(git(paths.root, 'remote').trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
