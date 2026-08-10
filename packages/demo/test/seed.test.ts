import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBoard } from '../src/board.js';
import { git } from '../src/git.js';
import { runsDir } from '../src/paths.js';
import { buildRepo } from '../src/repo.js';
import { listSeededBranches } from '../src/runs.js';
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
    // The local demo's real (slow, safe-on-a-trusted-machine) verify pipeline.
    expect(config).toContain(
      'verifySteps:\n  - name: install\n    command: bun install\n  - name: typecheck\n    command: bun run tsc\n  - name: test\n    command: bun test\n  - name: lint\n    command: bun run lint\n'
    );
  });

  test('verifySteps can be overridden without touching any other field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-board-verify-'));
    writeBoard(dir, {
      verifySteps: [{ name: 'verify', command: 'bun --version' }],
    });
    const config = readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
    expect(config).toContain(
      'verifySteps:\n  - name: verify\n    command: bun --version\n'
    );
    expect(config).not.toContain('bun install');
    expect(config).toContain('enabled: true'); // linear default untouched
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

  // A visitor session's verifySteps must stay non-empty (so it keeps
  // shadowing the PATCH-editable verifyCommand — see mergeQueue.ts's
  // verify()) but must never be the local demo's real install/tsc/test/lint
  // pipeline, which would run untrusted-triggered shell on the public box.
  test('the visitor sandbox gets a hermetic verify step, not the local demo pipeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-session-verify-'));
    const paths = seedSession(dir);
    const config = readFileSync(
      join(paths.root, '.dispatch', 'config.yml'),
      'utf8'
    );
    expect(config).toContain(
      'verifySteps:\n  - name: verify\n    command: bun --version\n'
    );
    expect(config).not.toContain('bun install');
    expect(config).not.toContain('bun run tsc');
  });

  // Regression for the t-6c40de landmine: Orchestrator.resolveBase bases a
  // blocked task's new worktree on its blocker's most recent run branch —
  // for t-2e91aa that's a review/verify run's branch, which a seeded
  // fixture only ever narrates in JSONL, never actually creates via `git
  // worktree add`. Without ensureRunBranchesExist, `git worktree add` fails
  // resolving that ref and dispatching t-6c40de 500s.
  test('every branch a seeded run references is real, locally and on origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-session-branches-'));
    const paths = seedSession(dir);

    const branches = listSeededBranches(paths.root, paths.home);
    expect(branches.length).toBeGreaterThan(0);
    expect(branches).toContain('dispatch/verify-t-2e91aa-4b91de');

    const rootBranches = git(paths.root, 'branch', '--list');
    const originBranches = git(paths.origin, 'branch', '--list');
    for (const branch of branches) {
      expect(rootBranches).toContain(branch);
      expect(originBranches).toContain(branch);
    }
  });

  // The board syncer captures refs/remotes/origin/<trunk> before its first
  // pull and, when that pull rebase-conflicts, materializes the bystander
  // files from it. A repo that only ever pushed has no such ref, so that one
  // cycle would drop whatever else trunk had picked up.
  test('the owner clone has remote-tracking refs, not just pushed branches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-session-refs-'));
    const paths = seedSession(dir);

    expect(
      git(paths.root, 'rev-parse', 'refs/remotes/origin/main').trim()
    ).toBe(git(paths.root, 'rev-parse', 'refs/heads/main').trim());
    for (const branch of listSeededBranches(paths.root, paths.home)) {
      expect(() =>
        git(paths.root, 'rev-parse', `refs/remotes/origin/${branch}`)
      ).not.toThrow();
    }
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
