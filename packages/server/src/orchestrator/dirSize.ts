import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How many entries a single measurement will look at before giving up.
 *
 * A worktree is a whole checkout, and some of them contain a `node_modules`
 * with a few hundred thousand files. Walking that on every branch listing would
 * make the page slower than the disk usage it is reporting. The cap keeps the
 * measurement bounded; `truncated` says so rather than reporting a number that
 * quietly means "some of it".
 */
const MAX_ENTRIES = 20_000;

export interface DirSize {
  bytes: number;
  /** True when the walk hit the cap, so `bytes` is a floor and not a total. */
  truncated: boolean;
}

/**
 * Recursive size of a directory, bounded.
 *
 * Deliberately not `du`: shelling out per branch is slower than this for small
 * trees, and it would have to be made safe against paths with spaces on every
 * platform. Symlinks are counted by their own size and never followed, so a
 * link pointing back up the tree cannot send this into a loop.
 */
export function dirSizeBytes(root: string): DirSize {
  let bytes = 0;
  let seen = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that vanished mid-walk (a worktree being removed while the
      // page polls) is not an error worth failing the whole listing over.
      continue;
    }
    for (const entry of entries) {
      if (seen >= MAX_ENTRIES) return { bytes, truncated: true };
      seen += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(path);
        continue;
      }
      try {
        bytes += statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      } catch {
        // Same reasoning as above: skip the entry, keep the total.
      }
    }
  }
  return { bytes, truncated: false };
}
