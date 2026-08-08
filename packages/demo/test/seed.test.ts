import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../src/git.js';
import { buildRepo } from '../src/repo.js';

function makeBareOrigin(dir: string): string {
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  return origin;
}

describe('buildRepo with a local remote', () => {
  test('pushes main and fix branches to the given remote, never github', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-seed-'));
    const origin = makeBareOrigin(dir);
    const root = join(dir, 'storefront');

    buildRepo({ root, push: true, remote: origin });

    const remotes = git(root, 'remote', '-v');
    expect(remotes).toContain(origin);
    expect(remotes).not.toContain('github.com');
    const branches = git(origin, 'branch', '--list');
    expect(branches).toContain('main');
    expect(branches).toContain(
      'dispatch/t-2e91aa-move-cart-state-to-the-session'
    );
  });
});
