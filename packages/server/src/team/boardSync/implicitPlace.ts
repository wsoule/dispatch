import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolvePushTarget } from '../../gitTarget.js';
import type { AsyncGitRunner } from '../../sync/worktree.js';
import { sameRemote } from '../federation/onboarding.js';

// Whether this replica has read another replica's changes: v1 board ops
// (`cursors`) or signed federation logs (`fed_cursors`, once it exists).
function sawOthers(db: Database, replica: string): boolean {
  const count = (table: string): number =>
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE replica != ? AND seq > 0`
      )
      .get(replica)?.n ?? 0;
  const hasFed =
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fed_cursors'"
      )
      .get() !== null;
  return count('cursors') > 0 || (hasFed && count('fed_cursors') > 0);
}

/**
 * For a config turned on before sync needed a place (`sync.enabled` alone,
 * which once meant origin): the project remote its existing sync clone
 * already exchanged other replicas' changes through, or null. That place
 * was chosen in effect, by a team mid-collaboration; anything less is not.
 */
export async function implicitRemote(
  rootDir: string,
  syncDir: string,
  db: Database,
  replica: string,
  git: AsyncGitRunner
): Promise<string | null> {
  const clone = join(syncDir, 'repo');
  if (!existsSync(clone) || !sawOthers(db, replica)) return null;
  const got = await git(clone, ['remote', 'get-url', 'origin']);
  if (got.status !== 0) return null;
  const url = got.stdout.trim();
  const names = await git(rootDir, ['remote']);
  if (names.status !== 0) return null;
  for (const name of names.stdout.split('\n').map((n) => n.trim())) {
    if (name === '') continue;
    const at = await resolvePushTarget(rootDir, { remote: name }, git);
    if (at !== null && (at === url || sameRemote(at, url) === true))
      return name;
  }
  return null;
}
