import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBoard } from '../src/board.js';
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

describe('writeBoard options', () => {
  test('extraActors lands in team.yml; linear/carto can be disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-board-'));
    writeBoard(dir, {
      extraActors: [
        {
          handle: 'demo',
          email: 'demo@example.com',
          displayName: 'You (demo)',
        },
      ],
      linearEnabled: false,
      cartoEnabled: false,
    });
    const team = readFileSync(join(dir, '.dispatch', 'team.yml'), 'utf8');
    expect(team).toContain('handle: demo');
    const config = readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
    expect(config).toContain('enabled: false');
    expect(config).toContain('enabled: off');
    expect(config).not.toContain('enabled: true\n');
  });

  test('default output is unchanged (no opts)', () => {
    const a = mkdtempSync(join(tmpdir(), 'demo-board-a-'));
    writeBoard(a);
    const config = readFileSync(join(a, '.dispatch', 'config.yml'), 'utf8');
    expect(config).toContain('enabled: true'); // linear
    expect(config).toContain('enabled: on'); // carto
  });
});
