import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitRunner } from '../../src/sync/worktree.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import {
  initGitRepo,
  runGitSync,
  worktreeSiblingPath,
} from '../orchestrator/helpers.js';

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

// Reads the SHARED (`--local`) config flag `git sparse-checkout init --cone`
// sets as a side effect — checked directly against real git state rather
// than any internal SyncWorktree detail, per the brief's "assert on the
// actual state of .git/config" requirement.
function extensionEnabled(repo: string): boolean {
  const result = run(repo, [
    'config',
    '--local',
    '--get',
    'extensions.worktreeConfig',
  ]);
  return result.status === 0 && result.stdout.trim() === 'true';
}

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

  it('falls through to local main when origin/HEAD is a stale symref (target branch renamed or deleted)', () => {
    const repo = initGitRepo();
    // `git symbolic-ref` only writes the ref FILE — it never checks the
    // target exists. This is exactly what a remote's default branch being
    // renamed or deleted leaves behind: the local symref still reads back
    // successfully, but resolves to nothing.
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/ghost-branch',
    ]);
    const readBack = runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]).trim();
    expect(readBack).toBe('refs/remotes/origin/ghost-branch');

    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();
    expect(worktree?.trunkRef()).toBe('main');
    expect(() => worktree?.ensure()).not.toThrow();
    expect(existsSync(worktree?.path ?? '')).toBe(true);
    rmSync(repo, { recursive: true, force: true });
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

  it('checks out via the origin/<trunk> fallback when no local branch of that name exists', () => {
    const upstream = mkdtempSync(join(tmpdir(), 'dispatch-origin-'));
    runGitSync(upstream, ['init', '--bare', '-b', 'main']);

    const repo = initGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', upstream]);
    // Push local main's content to a differently-named branch on origin, so
    // after fetching the repo has refs/remotes/origin/trunk but NO local
    // refs/heads/trunk at all — the exact gap checkoutRef()'s fallback to
    // `origin/<trunk>` exists to cover.
    runGitSync(repo, ['push', 'origin', 'main:trunk']);
    runGitSync(repo, ['fetch', 'origin']);
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);
    const localTrunk = run(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/trunk',
    ]);
    expect(localTrunk.status).not.toBe(0);

    const worktree = SyncWorktree.open(repo, run);
    expect(worktree?.trunkRef()).toBe('trunk');

    worktree?.ensure();

    expect(existsSync(worktree?.path ?? '')).toBe(true);
    const head = runGitSync(worktree?.path ?? '', ['rev-parse', 'HEAD']).trim();
    const originTrunkHead = runGitSync(repo, [
      'rev-parse',
      'origin/trunk',
    ]).trim();
    expect(head).toBe(originTrunkHead);
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
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

  it('checks out only .dispatch/, not the rest of trunk (sparse, cone-mode)', () => {
    const repo = initGitRepo();
    mkdirSync(join(repo, '.dispatch', 'tasks'), { recursive: true });
    writeFileSync(join(repo, '.dispatch', 'tasks', 'a.md'), 'task\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'unrelated source\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add .dispatch and src']);

    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();
    worktree?.ensure();

    const path = worktree?.path ?? '';
    expect(existsSync(join(path, '.dispatch', 'tasks', 'a.md'))).toBe(true);
    // `src/`, a full-sized subdirectory of trunk this worktree never reads
    // or writes, must not be materialized on disk.
    expect(existsSync(join(path, 'src'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('exists() is false before ensure() and true after, without creating anything itself', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    expect(worktree).not.toBeNull();

    expect(worktree?.exists()).toBe(false);
    expect(existsSync(worktree?.path ?? '')).toBe(false);

    worktree?.ensure();
    expect(worktree?.exists()).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  it('falls back to a full checkout when sparse-checkout is unavailable, logging once', () => {
    const repo = initGitRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'unrelated source\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add src alongside .dispatch']);

    // Stands in for git < 2.25, where `sparse-checkout` is an unknown
    // subcommand — this is about SyncWorktree's own control flow when the
    // step fails, not about reproducing git's real old-version behaviour.
    const stubRun: GitRunner = (cwd, args) => {
      if (args[0] === 'sparse-checkout') {
        return {
          status: 1,
          stdout: '',
          stderr: "git: 'sparse-checkout' is not a git command",
        };
      }
      return run(cwd, args);
    };

    const worktree = SyncWorktree.open(repo, stubRun);
    expect(worktree).not.toBeNull();

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    expect(() => worktree?.ensure()).not.toThrow();

    expect(existsSync(worktree?.path ?? '')).toBe(true);
    // Full (unsparse) checkout: everything trunk has is present, not just
    // .dispatch/ — this worktree is just larger than it needs to be.
    expect(existsSync(join(worktree?.path ?? '', 'src', 'index.ts'))).toBe(
      true
    );
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes('sparse-checkout')
      )
    ).toBe(true);
    expect(errorSpy.mock.calls.length).toBe(1);

    // Force a second addWorktree() by wiping the directory out from under
    // it — the fallback must keep working, but the warning must not repeat.
    rmSync(worktree?.path ?? '', { recursive: true, force: true });
    errorSpy.mockClear();
    worktree?.ensure();
    expect(existsSync(worktree?.path ?? '')).toBe(true);
    expect(errorSpy.mock.calls.length).toBe(0);

    errorSpy.mockRestore();
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

// `git sparse-checkout init --cone` writes `extensions.worktreeConfig = true`
// into the repo's SHARED `.git/config` as an undisclosed side effect
// (confirmed empirically on git 2.55) — SyncWorktree tracks whether it was
// the one that set this and only ever unsets it when that's provably safe.
describe('SyncWorktree / extensions.worktreeConfig', () => {
  it('leaves an already-enabled extension flag untouched by ensure() and remove()', () => {
    const repo = initGitRepo();
    // Simulates a repo where the extension was already on before dispatch
    // ever ran — e.g. the user's own `git worktree` usage elsewhere. This is
    // never ours to unset, no matter what we do with our own worktree.
    runGitSync(repo, [
      'config',
      '--local',
      'extensions.worktreeConfig',
      'true',
    ]);

    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(extensionEnabled(repo)).toBe(true);

    worktree?.remove();
    expect(extensionEnabled(repo)).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  it('still checks out only .dispatch when the extension was already on from elsewhere', () => {
    const repo = initGitRepo();
    runGitSync(repo, [
      'config',
      '--local',
      'extensions.worktreeConfig',
      'true',
    ]);
    mkdirSync(join(repo, '.dispatch', 'tasks'), { recursive: true });
    writeFileSync(join(repo, '.dispatch', 'tasks', 'a.md'), 'task\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'unrelated source\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add .dispatch and src']);

    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();

    const path = worktree?.path ?? '';
    expect(existsSync(join(path, '.dispatch', 'tasks', 'a.md'))).toBe(true);
    expect(existsSync(join(path, 'src'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('sets the extension on ensure() and unsets it on remove() when it owns it', () => {
    const repo = initGitRepo();
    expect(extensionEnabled(repo)).toBe(false);

    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(extensionEnabled(repo)).toBe(true);

    worktree?.remove();
    expect(extensionEnabled(repo)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('cleans up correctly from a fresh instance, simulating a daemon restart', () => {
    const repo = initGitRepo();
    const first = SyncWorktree.open(repo, run);
    first?.ensure();
    expect(extensionEnabled(repo)).toBe(true);

    // A brand-new instance — as a restarted daemon would create — has none
    // of `first`'s in-memory state. It must still find the on-disk marker
    // `first` wrote and unset the extension correctly.
    const second = SyncWorktree.open(repo, run);
    second?.remove();
    expect(extensionEnabled(repo)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves the extension on when another worktree has its own worktree-scoped config', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(extensionEnabled(repo)).toBe(true);

    // A second, unrelated linked worktree that picked up its own
    // worktree-scoped config once the extension came on — exactly the case
    // that makes blindly unsetting the extension worse than leaving it: git
    // would silently stop reading this file for a worktree unrelated to us.
    const otherPath = worktreeSiblingPath(repo, 'other');
    runGitSync(repo, ['worktree', 'add', '--detach', otherPath, 'main']);
    runGitSync(otherPath, [
      'config',
      '--worktree',
      'core.sparseCheckout',
      'false',
    ]);

    worktree?.remove();

    expect(extensionEnabled(repo)).toBe(true);
    const otherConfig = runGitSync(otherPath, [
      'config',
      '--worktree',
      '--get',
      'core.sparseCheckout',
    ]).trim();
    expect(otherConfig).toBe('false');

    runGitSync(repo, ['worktree', 'remove', '--force', otherPath]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('retries cleanup on a later remove() once the other worktree is gone', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();

    const otherPath = worktreeSiblingPath(repo, 'other');
    runGitSync(repo, ['worktree', 'add', '--detach', otherPath, 'main']);
    runGitSync(otherPath, [
      'config',
      '--worktree',
      'core.sparseCheckout',
      'false',
    ]);

    worktree?.remove();
    expect(extensionEnabled(repo)).toBe(true);

    // The other worktree goes away; recreate ours and remove it again — the
    // marker this instance kept around must let a later remove() finish the
    // job it deferred the first time.
    runGitSync(repo, ['worktree', 'remove', '--force', otherPath]);
    worktree?.ensure();
    worktree?.remove();

    expect(extensionEnabled(repo)).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps the marker when --unset fails, so a later remove() retries and finishes the job', () => {
    const repo = initGitRepo();
    const worktree = SyncWorktree.open(repo, run);
    worktree?.ensure();
    expect(extensionEnabled(repo)).toBe(true);

    // Stands in for a duplicate `[extensions]` key or a stale
    // `config.lock` from a crashed git: `--get` still reports the flag as
    // on (status 0, "true"), but `--unset` fails (git uses status 5 for
    // "tried to unset an option which does not exist" as well as other
    // multi-value/lock failures) and leaves the real config untouched.
    const failingUnsetRun: GitRunner = (cwd, args) => {
      if (args[0] === 'config' && args.includes('--unset')) {
        return { status: 5, stdout: '', stderr: 'fatal: could not unset' };
      }
      return run(cwd, args);
    };
    const failingWorktree = SyncWorktree.open(repo, failingUnsetRun);
    failingWorktree?.remove();

    // The unset call failed, so ownership must NOT be forfeited: the flag
    // stays on and (unobservably here, but per the fix) the marker survives.
    expect(extensionEnabled(repo)).toBe(true);

    // A later remove() — using a real, non-failing GitRunner — must still
    // be able to finish the job the failed attempt deferred, proving the
    // marker was kept rather than deleted despite the failure.
    const retryWorktree = SyncWorktree.open(repo, run);
    retryWorktree?.ensure();
    retryWorktree?.remove();
    expect(extensionEnabled(repo)).toBe(false);

    rmSync(repo, { recursive: true, force: true });
  });
});
