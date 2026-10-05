import { absoluteGitLocation } from '@dispatch-foo/core';

import type { AsyncGitRunner } from './sync/worktree.js';

// Where a push goes, for everything that pushes to git on the project's
// behalf — the receipts push here, board sync in team/ — resolved the same
// way so `remote:` and `repo:` mean one thing in every block of config.yml.

/** A push target as the config names it: one of the project's remotes by
 *  name, or a repository of its own. */
export interface PushTarget {
  remote?: string;
  repo?: string;
}

/**
 * The location a push target points at, in a form git reads the same from
 * any directory: `repo` itself, or the URL of the project's `remote`. Null
 * when the remote is not one this project has.
 *
 * A relative path — `repo: ../board.git`, or an `origin` added as one — is
 * made absolute against the project root, where the person meant it (see
 * absoluteGitLocation).
 */
export async function resolvePushTarget(
  rootDir: string,
  target: PushTarget,
  git: AsyncGitRunner
): Promise<string | null> {
  if (target.repo !== undefined)
    return absoluteGitLocation(rootDir, target.repo);
  if (target.remote === undefined) return null;
  const res = await git(rootDir, ['remote', 'get-url', target.remote]);
  if (res.status !== 0) return null;
  return absoluteGitLocation(rootDir, res.stdout.trim());
}
