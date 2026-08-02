// This module must stay free of node:* imports — it is exported from both
// the Node entry and the browser-safe '@dispatch/core/browser' subpath.

// A `dir/**` entry matches any path under `dir/`; anything else is an exact
// path. This is deliberately not a general glob matcher — see tasksConflict.
const GLOB_SUFFIX = '/**';

function globDir(pattern: string): string {
  return pattern.slice(0, -GLOB_SUFFIX.length);
}

// Whether an exact path falls under a `dir/**` glob's directory.
function pathUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

// Whether two entries can ever name the same file: globs overlap if either
// directory contains the other; a glob and a path overlap if it's under it.
function entriesOverlap(a: string, b: string): boolean {
  const aGlob = a.endsWith(GLOB_SUFFIX);
  const bGlob = b.endsWith(GLOB_SUFFIX);
  if (aGlob && bGlob) {
    const dirA = globDir(a);
    const dirB = globDir(b);
    return pathUnderDir(dirA, dirB) || pathUnderDir(dirB, dirA);
  }
  if (aGlob) return pathUnderDir(b, globDir(a));
  if (bGlob) return pathUnderDir(a, globDir(b));
  return a === b;
}

/** Two tasks conflict when their write-sets intersect; empty means unknown. */
export function tasksConflict(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => entriesOverlap(pa, pb)));
}

// Greedy batching: keeps each ready task, in order, that doesn't conflict
// with one already accepted, until `limit` is reached.
export function schedulableBatch(
  ready: { id: string; writes: string[] }[],
  limit: number
): string[] {
  const accepted: { id: string; writes: string[] }[] = [];
  for (const task of ready) {
    if (accepted.length >= limit) break;
    const conflicts = accepted.some((a) =>
      tasksConflict(a.writes, task.writes)
    );
    if (!conflicts) accepted.push(task);
  }
  return accepted.map((t) => t.id);
}
