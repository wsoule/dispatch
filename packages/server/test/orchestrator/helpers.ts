import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
