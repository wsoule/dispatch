import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Runs a git command synchronously and throws with stderr on failure — used
// by tests that need to set up or inspect real repo state (as opposed to the
// orchestrator's own git wrapper, which is exactly what's under test).
export function runGitSync(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`
    );
  }
  return result.stdout.toString('utf8');
}

// Creates a fresh temp dir, git-inits it on branch `main`, and makes one
// commit so there is a real HEAD to base worktrees/branches on — `git
// worktree add -b <branch> <path> <base>` fails against an empty repo with no
// commits, and every orchestrator test needs a realistic starting point.
export function initGitRepo(prefix = 'dispatch-orch-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

/**
 * A unique path for a worktree belonging to `repo`, beside it rather than
 * inside it.
 *
 * Worktrees have to live outside the checkout they belong to, so tests place
 * them next to `repo` — but writing that as `join(repo, '..', 'wt-thing')`
 * resolves to the SHARED system temp root, because `initGitRepo` only
 * randomizes the repo directory itself. Every test using a fixed name therefore
 * competes for one global path, and a directory left behind by a previous run
 * collides with the next one: `git worktree add` refuses a path that already
 * exists, so the suite passes on a clean machine and then fails on every rerun.
 *
 * Prefixing with the repo's own (already unique) directory name makes the path
 * unique per `initGitRepo()` call while keeping it a sibling, so repeated local
 * runs stop interfering with each other.
 */
export function worktreeSiblingPath(repo: string, name: string): string {
  return join(repo, '..', `${basename(repo)}-${name}`);
}
