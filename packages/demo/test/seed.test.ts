import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBoard } from '../src/board.js';
import { git } from '../src/git.js';
import { runsDir } from '../src/paths.js';
import { buildRepo } from '../src/repo.js';
import { seedSession, sessionPaths, VISITOR } from '../src/seed.js';

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

describe('seedSession', () => {
  test('builds origin, owner clone, teammate clone, board, runs — no github anywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-session-'));
    const paths = seedSession(dir);

    // layout
    expect(existsSync(join(paths.origin, 'HEAD'))).toBe(true); // bare repo
    expect(existsSync(join(paths.root, '.dispatch', 'tasks'))).toBe(true);
    expect(existsSync(join(paths.teammateRoot, '.dispatch', 'tasks'))).toBe(
      true
    );

    // no GitHub remote in either clone
    expect(git(paths.root, 'remote', '-v')).not.toContain('github.com');
    expect(git(paths.teammateRoot, 'remote', '-v')).not.toContain('github.com');

    // run history + review diff snapshots for the visitor
    const runs = readdirSync(runsDir(paths.root, paths.home));
    expect(runs.some((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(runs).toContain('r-2e91aa.diff.json');

    // visitor is on the roster and owns the identity
    const team = readFileSync(
      join(paths.root, '.dispatch', 'team.yml'),
      'utf8'
    );
    expect(team).toContain(`handle: ${VISITOR.handle}`);
  });

  test('sessionPaths derives the fixed sub-paths under dir', () => {
    const paths = sessionPaths('/tmp/demo-session-xyz');
    expect(paths.dir).toBe('/tmp/demo-session-xyz');
    expect(paths.origin).toBe('/tmp/demo-session-xyz/origin.git');
    expect(paths.root).toBe('/tmp/demo-session-xyz/storefront');
    expect(paths.home).toBe('/tmp/demo-session-xyz/home');
    expect(paths.teammateRoot).toBe(
      '/tmp/demo-session-xyz/teammate/storefront'
    );
  });
});
