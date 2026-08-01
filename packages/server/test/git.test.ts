import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitRepo } from '../src/git/commands.js';
import type { CommandRunner } from '../src/orchestrator/pr.js';

// Fixture setup only (GitRepo itself is exercised via its own async methods
// below) — throws on failure so a broken fixture fails loudly.
function setupGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`
    );
  }
}

let root: string;
let repo: GitRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-gitrepo-'));
  setupGit(root, ['init', '-b', 'main']);
  setupGit(root, ['config', 'user.email', 'test@example.com']);
  setupGit(root, ['config', 'user.name', 'Test']);
  repo = new GitRepo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitRepo: status -> stage -> commit -> log', () => {
  it('drives a file from untracked through a committed log entry', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');

    const untracked = await repo.status();
    if (!untracked.ok) throw new Error(untracked.stderr);
    expect(untracked.branch).toBe('main');
    expect(untracked.untracked).toEqual(['a.txt']);
    expect(untracked.staged).toEqual([]);

    const staged = await repo.stage(['a.txt']);
    expect(staged.ok).toBe(true);

    const afterStage = await repo.status();
    if (!afterStage.ok) throw new Error(afterStage.stderr);
    expect(afterStage.staged).toEqual([{ path: 'a.txt', status: 'A' }]);
    expect(afterStage.untracked).toEqual([]);

    const committed = await repo.commit({ message: 'feat: add a.txt' });
    if (!committed.ok) throw new Error(committed.stderr);
    expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);

    const clean = await repo.status();
    if (!clean.ok) throw new Error(clean.stderr);
    expect(clean.staged).toEqual([]);
    expect(clean.unstaged).toEqual([]);
    expect(clean.untracked).toEqual([]);

    const log = await repo.log();
    if (!log.ok) throw new Error(log.stderr);
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0].subject).toBe('feat: add a.txt');
    expect(log.commits[0].sha).toBe(committed.sha);
    expect(log.commits[0].parents).toEqual([]);
  });
});

describe('GitRepo: unstage and discard', () => {
  it('unstage moves a change back to unstaged without dropping it', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);

    const result = await repo.unstage(['a.txt']);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual(['a.txt']);
  });

  it('discard removes an untracked file entirely', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const result = await repo.discard(['scratch.txt']);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
  });

  it('discard reverts a tracked file to its last committed content', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed a.txt' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');

    const result = await repo.discard(['a.txt']);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.unstaged).toEqual([]);
  });
});

describe('GitRepo: diff', () => {
  it('shows a staged patch, distinct from an empty unstaged diff', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);

    const staged = await repo.diff({ staged: true });
    if (!staged.ok) throw new Error(staged.stderr);
    expect(staged.patch).toContain('a.txt');
    expect(staged.patch).toContain('+hello');

    const unstaged = await repo.diff({ staged: false });
    if (!unstaged.ok) throw new Error(unstaged.stderr);
    expect(unstaged.patch).toBe('');
  });
});

describe('GitRepo: branches and checkout', () => {
  it('creates, lists, checks out, and deletes a branch', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });

    const created = await repo.createBranch('feature/x');
    expect(created.ok).toBe(true);

    const listed = await repo.branches();
    if (!listed.ok) throw new Error(listed.stderr);
    expect(listed.branches.map((b) => b.name)).toContain('feature/x');
    const current = listed.branches.find((b) => b.name === 'main');
    expect(current?.isCurrent).toBe(true);

    const checkedOut = await repo.checkout('feature/x');
    expect(checkedOut.ok).toBe(true);

    const backOnMain = await repo.checkout('main');
    expect(backOnMain.ok).toBe(true);

    // feature/x has no commits of its own beyond main, so a non-force delete
    // (git's `-d`) succeeds — this is the "safe" path GitRepo itself allows.
    const deleted = await repo.deleteBranch('feature/x', false);
    expect(deleted.ok).toBe(true);
  });
});

describe('GitRepo: stash', () => {
  it('pushes, lists, and pops a stash', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');

    const pushed = await repo.stashPush('wip');
    expect(pushed.ok).toBe(true);

    const clean = await repo.status();
    if (!clean.ok) throw new Error(clean.stderr);
    expect(clean.unstaged).toEqual([]);

    const list = await repo.stashList();
    if (!list.ok) throw new Error(list.stderr);
    expect(list.stashes).toHaveLength(1);
    expect(list.stashes[0].message).toContain('wip');

    const popped = await repo.stashPop(0);
    expect(popped.ok).toBe(true);

    const restored = await repo.status();
    if (!restored.ok) throw new Error(restored.stderr);
    expect(restored.unstaged).toEqual([{ path: 'a.txt', status: 'M' }]);
  });
});

describe('GitRepo: never throws on a failing git command', () => {
  it('returns ok:false for a commit with nothing staged', async () => {
    const result = await repo.commit({ message: 'nothing to commit' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('returns ok:false for checking out an unknown branch', async () => {
    const result = await repo.checkout('does-not-exist');
    expect(result.ok).toBe(false);
  });
});

describe('GitRepo: path and ref safety', () => {
  it('rejects a path that escapes the repo root without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const unsafeRepo = new GitRepo('/tmp/some-repo', fakeRun);

    const result = await unsafeRepo.stage(['../../etc/passwd']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a ref argument that looks like a flag without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const unsafeRepo = new GitRepo('/tmp/some-repo', fakeRun);

    const result = await unsafeRepo.checkout('--upload-pack=evil');

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
