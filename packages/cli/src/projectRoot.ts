import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

// Two paths naming the same directory, whichever way each is spelled
// (macOS's /var → /private/var, a symlinked checkout). Unreadable paths
// compare by string so this never throws.
function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The repository root `cwd` belongs to, or `cwd` itself outside a git repo.
 *
 * Every Dispatch run executes inside a linked git worktree of its project
 * (`~/.dispatch/worktrees/<key>/<run id>`), and a worktree is a checkout of a
 * project, never a project: the daemon, its database and its registry entry
 * all live at the main checkout. Keying anything on the worktree path instead
 * finds no daemon there and spawns a stray one with the worktree as its root —
 * which is how daemon files for throwaway checkouts appeared on 2026-09-08.
 *
 * `--git-common-dir` answers `<root>/.git` from a linked worktree AND from the
 * main checkout, so its parent is the root either way; that also normalizes a
 * subdirectory of the main checkout to the root. Anything that is not a
 * plain `.git` directory (a submodule's gitdir, a `--separate-git-dir`
 * layout) leaves `cwd` alone rather than guessing. `cwd` is returned in the
 * caller's own spelling when it already IS the root, so a project directory
 * keys exactly as it did before this resolver existed. Never throws: a
 * missing `git`, a non-repo, or a git too old for `--path-format` all fall
 * back to `cwd`.
 */
export function projectRootFor(cwd: string): string {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (result.status !== 0) return cwd;
  const commonDir = result.stdout.trim();
  if (basename(commonDir) !== '.git') return cwd;
  const root = dirname(commonDir);
  return sameDirectory(root, cwd) ? cwd : root;
}

/**
 * The PROJECT root a CLI invocation should act on, given its cwd.
 *
 * The executor publishes the mapping as DISPATCH_PROJECT_ROOT for every run
 * whose worktree differs from the project, and that explicit answer wins.
 * Without it — a human's shell inside a worktree they keep themselves, or a
 * subdirectory of the checkout — git supplies the same answer (see
 * `projectRootFor`). A plain project directory resolves to itself.
 */
export function projectRoot(cwd: string): string {
  const override = process.env.DISPATCH_PROJECT_ROOT;
  if (override !== undefined && override !== '') return override;
  return projectRootFor(cwd);
}
