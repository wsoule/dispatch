import type { GitFileChange } from '@dispatch/client';

import type { GitFileRow } from './gitPanels';

/** Flattens a `GitStatus`'s four buckets into the Files panel's one ordered list. A path in
 * both `conflicted` and `unstaged` is kept only in the conflicted section. */
export function fileRowsFromStatus(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  untracked: string[],
  conflicted: string[]
): GitFileRow[] {
  const conflictedSet = new Set(conflicted);
  const rows: GitFileRow[] = conflicted.map((path) => ({
    section: 'conflicted' as const,
    path,
  }));
  for (const f of staged) rows.push({ section: 'staged', path: f.path });
  for (const f of unstaged) {
    if (!conflictedSet.has(f.path))
      rows.push({ section: 'unstaged', path: f.path });
  }
  for (const path of untracked) rows.push({ section: 'untracked', path });
  return rows;
}
