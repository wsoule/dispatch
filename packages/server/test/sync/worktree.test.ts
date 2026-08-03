import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitRunner } from '../../src/sync/worktree.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { initGitRepo, runGitSync } from '../orchestrator/helpers.js';

// Same shape WorktreeManager's internal runGit uses, exposed here since
// SyncWorktree takes its GitRunner injected rather than shelling out itself.
const run: GitRunner = (cwd, args) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('SyncWorktree.open', () => {
  it('returns null when the repo has neither origin/HEAD nor a local main/master', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    runGitSync(repo, ['init', '-b', 'trunk']);
    runGitSync(repo, ['config', 'user.email', 'test@example.com']);
    runGitSync(repo, ['config', 'user.name', 'Test']);
    runGitSync(repo, ['commit', '--allow-empty', '-m', 'initial commit']);

    expect(SyncWorktree.open(repo, run)).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it('resolves trunk from a local main branch', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();
    expect(worktree?.trunkRef()).toBe('main');
    rmSync(repo, { recursive: true, force: true });
  });

  it('falls back to a local master branch when there is no main', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    runGitSync(repo, ['init', '-b', 'master']);
    runGitSync(repo, ['config', 'user.email', 'test@example.com']);
    runGitSync(repo, ['config', 'user.name', 'Test']);
    runGitSync(repo, ['commit', '--allow-empty', '-m', 'initial commit']);

    const worktree = SyncWorktree.open(repo, run);
    expect(worktree?.trunkRef()).toBe('master');
    rmSync(repo, { recursive: true, force: true });
  });

  it('prefers origin/HEAD over a local main/master when a remote is configured', () => {
    const upstream = mkdtempSync(join(tmpdir(), 'dispatch-origin-'));
    runGitSync(upstream, ['init', '--bare', '-b', 'trunk']);

    const repo = initGitRepo();
    runGitSync(repo, ['checkout', '-b', 'trunk']);
    runGitSync(repo, ['checkout', 'main']);
    runGitSync(repo, ['branch', '-D', 'trunk']);
    runGitSync(repo, ['checkout', '-b', 'trunk']);
    runGitSync(repo, ['remote', 'add', 'origin', upstream]);
    runGitSync(repo, ['push', 'origin', 'trunk']);
    runGitSync(repo, ['fetch', 'origin']);
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);

    const worktree = SyncWorktree.open(repo, run);
    expect(worktree?.trunkRef()).toBe('trunk');
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  });
});

describe('SyncWorktree location', () => {
  it('places the worktree outside the user repo, under DISPATCH_HOME', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();
    const path = worktree?.path ?? '';
    expect(path.startsWith(fakeHome)).toBe(true);
    expect(path.startsWith(repo)).toBe(false);
    expect(path.includes(join('worktrees'))).toBe(true);
    expect(path.endsWith(join('board'))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('SyncWorktree.ensure / remove', () => {
  it('creates the worktree with HEAD at trunk', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();
    worktree?.ensure();

    expect(existsSync(worktree?.path ?? '')).toBe(true);
    const head = runGitSync(worktree?.path ?? '', ['rev-parse', 'HEAD']).trim();
    const trunkHead = runGitSync(repo, ['rev-parse', 'main']).trim();
    expect(head).toBe(trunkHead);
    rmSync(repo, { recursive: true, force: true });
  });

  it('is a clean no-op when called a second time', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(() => worktree?.ensure()).not.toThrow();

    const list = runGitSync(repo, ['worktree', 'list', '--porcelain']);
    const boardEntries = list
      .split('\n')
      .filter((line) => line.startsWith('worktree') && line.includes('board'));
    expect(boardEntries.length).toBe(1);
    rmSync(repo, { recursive: true, force: true });
  });

  it('recreates the worktree after its directory is deleted out from under it', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    const path = worktree?.path ?? '';
    expect(existsSync(path)).toBe(true);

    // Simulate the directory vanishing without `git worktree remove` — the
    // exact crash/cleanup scenario ensure() must self-heal from.
    rmSync(path, { recursive: true, force: true });
    expect(existsSync(path)).toBe(false);

    worktree?.ensure();
    expect(existsSync(path)).toBe(true);
    const head = runGitSync(path, ['rev-parse', 'HEAD']).trim();
    const trunkHead = runGitSync(repo, ['rev-parse', 'main']).trim();
    expect(head).toBe(trunkHead);
    rmSync(repo, { recursive: true, force: true });
  });

  it('recreates the worktree when git loses track of it but the directory survives', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    const path = worktree?.path ?? '';
    expect(existsSync(path)).toBe(true);

    // Wipe the main repo's worktree admin metadata directly, leaving the
    // worktree's own directory (and its .git file pointing back at the now-
    // gone metadata) untouched — this is the second self-healing case named
    // in the brief, distinct from the directory itself going missing:
    // `git worktree list` in the main repo no longer knows this path exists.
    rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true });
    const listBefore = runGitSync(repo, ['worktree', 'list', '--porcelain']);
    expect(listBefore.includes('board')).toBe(false);
    expect(existsSync(path)).toBe(true);

    worktree?.ensure();

    expect(existsSync(path)).toBe(true);
    const head = runGitSync(path, ['rev-parse', 'HEAD']).trim();
    const trunkHead = runGitSync(repo, ['rev-parse', 'main']).trim();
    expect(head).toBe(trunkHead);
    const listAfter = runGitSync(repo, ['worktree', 'list', '--porcelain']);
    const boardEntries = listAfter
      .split('\n')
      .filter((line) => line.startsWith('worktree') && line.includes('board'));
    expect(boardEntries.length).toBe(1);
    rmSync(repo, { recursive: true, force: true });
  });

  it('remove() deregisters the worktree from git worktree list', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(existsSync(worktree?.path ?? '')).toBe(true);

    worktree?.remove();

    expect(existsSync(worktree?.path ?? '')).toBe(false);
    const list = runGitSync(repo, ['worktree', 'list', '--porcelain']);
    expect(list.includes('board')).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});
