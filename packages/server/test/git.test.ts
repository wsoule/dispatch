import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitRepo,
  INVALID_REF_ERROR,
  PATH_ESCAPE_ERROR,
} from '../src/git/commands.js';
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

    const result = await repo.discard(['scratch.txt'], true);
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

    const result = await repo.discard(['a.txt'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.unstaged).toEqual([]);
  });

  it('refuses to run without confirm: true', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const result = await repo.discard(['scratch.txt'], false);

    expect(result.ok).toBe(false);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual(['scratch.txt']);
  });

  it('removes an untracked directory too (clean -d), not just files', async () => {
    mkdirSync(join(root, 'scratch-dir'));
    writeFileSync(join(root, 'scratch-dir', 'nested.txt'), 'temp\n');

    const result = await repo.discard(['scratch-dir'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
  });

  it('does not expand pathspec magic — a literal "*" never wipes the tree', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed a.txt' });
    writeFileSync(join(root, 'b.txt'), 'untracked\n');

    const result = await repo.discard(['*'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    // Neither file was touched — `*` was treated as a literal (nonexistent)
    // filename, not a wildcard, thanks to --literal-pathspecs.
    expect(status.untracked).toEqual(['b.txt']);
  });

  it('does not over-reject a real filename that merely starts with ".."', async () => {
    writeFileSync(join(root, '..foo.txt'), 'v1\n');

    const result = await repo.discard(['..foo.txt'], true);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
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

  it('refuses a force delete without confirm: true, even in-process', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    await repo.createBranch('feature/y');

    const result = await repo.deleteBranch('feature/y', true, false);

    expect(result.ok).toBe(false);
    const listed = await repo.branches();
    if (!listed.ok) throw new Error(listed.stderr);
    expect(listed.branches.map((b) => b.name)).toContain('feature/y');
  });

  it('force-deletes an unmerged branch once confirmed', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    await repo.createBranch('feature/z');
    await repo.checkout('feature/z');
    writeFileSync(join(root, 'unmerged.txt'), 'v1\n');
    await repo.stage(['unmerged.txt']);
    await repo.commit({ message: 'feat: unmerged work' });
    await repo.checkout('main');

    const result = await repo.deleteBranch('feature/z', true, true);

    expect(result.ok).toBe(true);
  });

  it('checking out a name that collides with a directory fails rather than restoring paths', async () => {
    // "src" is a directory with an uncommitted file, not a branch — without
    // `--`, checkout would silently restore paths under it instead of refusing.
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;\n');
    await repo.stage(['src/app.ts']);
    await repo.commit({ message: 'chore: seed src/app.ts' });
    writeFileSync(
      join(root, 'src', 'app.ts'),
      'export const x = 2; // uncommitted\n'
    );

    const result = await repo.checkout('src');

    expect(result.ok).toBe(false);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    // The uncommitted edit must still be there — not silently reverted.
    expect(status.unstaged).toEqual([{ path: 'src/app.ts', status: 'M' }]);
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

  it('refuses to drop a stash without confirm: true, even in-process', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    await repo.stashPush('wip');

    const result = await repo.stashDrop(0, false);

    expect(result.ok).toBe(false);
    const list = await repo.stashList();
    if (!list.ok) throw new Error(list.stderr);
    expect(list.stashes).toHaveLength(1);
  });

  it('drops a stash once confirmed', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    await repo.stashPush('wip');

    const result = await repo.stashDrop(0, true);

    expect(result.ok).toBe(true);
    const list = await repo.stashList();
    if (!list.ok) throw new Error(list.stderr);
    expect(list.stashes).toEqual([]);
  });
});

describe('GitRepo: stage-hunk and unstage-hunk', () => {
  it('stages a hunk by applying a real patch to the index', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const diff = await repo.diff({ staged: false });
    if (!diff.ok) throw new Error(diff.stderr);

    const result = await repo.stageHunk(diff.patch);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([{ path: 'a.txt', status: 'M' }]);
    expect(status.unstaged).toEqual([]);
  });

  it('unstages a hunk by applying the staged patch in reverse to the index', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const diff = await repo.diff({ staged: false });
    if (!diff.ok) throw new Error(diff.stderr);
    await repo.stageHunk(diff.patch);
    const stagedDiff = await repo.diff({ staged: true });
    if (!stagedDiff.ok) throw new Error(stagedDiff.stderr);

    const result = await repo.unstageHunk(stagedDiff.patch);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([{ path: 'a.txt', status: 'M' }]);
  });

  it('returns ok:false for a patch that does not apply', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed' });

    const result = await repo.stageHunk('not a real patch\n');

    expect(result.ok).toBe(false);
  });
});

describe('GitRepo: fetch remote validation', () => {
  it('rejects a URL/transport remote without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const unsafeRepo = new GitRepo(root, fakeRun);

    const result = await unsafeRepo.fetch('https://attacker.example/x.git');

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects an ext:: transport spec without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const unsafeRepo = new GitRepo(root, fakeRun);

    const result = await unsafeRepo.fetch('ext::sh -c touch /tmp/pwned');

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a leading-dash remote (a valueless flag like --prune) without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const unsafeRepo = new GitRepo(root, fakeRun);

    const result = await unsafeRepo.fetch('--prune');

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('lets a plain remote name reach git (and fail there if it does not exist)', async () => {
    const result = await repo.fetch('origin');

    // No such remote exists here — the point is the request reached real
    // git rather than being rejected by the name-shape check itself.
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.stderr).not.toBe(
        'invalid remote: expected a plain remote name'
      );
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

  it('rejects a path through an in-repo symlink pointing outside the repo root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'do not touch\n');
    symlinkSync(outside, join(root, 'escape-link'));

    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const guardedRepo = new GitRepo(root, fakeRun);

    const result = await guardedRepo.stage(['escape-link/secret.txt']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a nonexistent leaf under a symlinked directory pointing outside the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    symlinkSync(outside, join(root, 'escape-dir'));

    let called = false;
    const fakeRun: CommandRunner = async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    };
    const guardedRepo = new GitRepo(root, fakeRun);

    // The leaf doesn't exist yet — only the symlinked parent has to resolve.
    const result = await guardedRepo.stage(['escape-dir/newfile.txt']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('allows staging a tracked symlink whose own target lives outside the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'do not touch\n');
    // The symlink *file* sits inside the repo — only what it points to is
    // outside. `git add` on the link itself is a normal, supported op.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file'));

    const result = await repo.stage(['escape-file']);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([{ path: 'escape-file', status: 'A' }]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('GitRepo: commit sha resolution', () => {
  it('reports ok:false rather than an empty sha when rev-parse fails after a successful commit', async () => {
    const fakeRun: CommandRunner = async (_cwd, cmd) => {
      if (cmd.includes('commit')) return { ok: true, stdout: '', stderr: '' };
      if (cmd.includes('rev-parse')) {
        return { ok: false, stdout: '', stderr: 'fatal: ambiguous HEAD' };
      }
      return { ok: true, stdout: '', stderr: '' };
    };
    const fakeRepo = new GitRepo(root, fakeRun);

    const result = await fakeRepo.commit({ message: 'feat: x' });

    expect(result.ok).toBe(false);
  });
});

describe('GitRepo: show', () => {
  it('reads a file at a ref, not the working tree', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);
    writeFileSync(join(root, 'a.txt'), 'changed\n');

    const result = await repo.show('HEAD', 'a.txt');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contents).toBe('hello\n');
  });

  it('fails for a path that is not in the ref', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);

    const result = await repo.show('HEAD', 'missing.txt');

    expect(result.ok).toBe(false);
  });

  it('refuses a path that escapes the repository root', async () => {
    const result = await repo.show('HEAD', '../outside.txt');

    expect(result).toEqual({ ok: false, stderr: PATH_ESCAPE_ERROR });
  });

  it('refuses a ref that looks like a flag', async () => {
    const result = await repo.show('--upload-pack=x', 'a.txt');

    expect(result).toEqual({ ok: false, stderr: INVALID_REF_ERROR });
  });
});
