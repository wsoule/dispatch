// This module must stay free of node:* imports — it is exported from both
// the Node entry and the browser-safe '@dispatch/core/browser' subpath.

// A `dir/**` entry matches any path under `dir/`; anything else is an exact
// path. This is deliberately not a general glob matcher — see tasksConflict.
const GLOB_SUFFIX = '/**';

function globDir(pattern: string): string {
  return pattern.slice(0, -GLOB_SUFFIX.length);
}

// The escapes a synthesized `writes` entry carries. The forward direction is
// escapeGlobPath in the server's orchestrator/prReviewTask.ts — the owner of
// this character set; it is re-spelled rather than imported because core
// cannot depend on the server. Keep the two in step.
const GLOB_ESCAPE = /\\([\\*?[\]{}()+@|!])/g;

/**
 * The spelling a `writes` entry would have if nothing had escaped it. A PR
 * review task's writes arrive glob-escaped (`app/\[id\]/route.ts`) while a
 * human declares the same file plainly, and the two must compare equal here.
 * Only comparisons use this — never glob detection, see entriesOverlap.
 */
function unescapeGlobPath(entry: string): string {
  return entry.replace(GLOB_ESCAPE, '$1');
}

// Whether an exact path falls under a `dir/**` glob's directory.
function pathUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

// Whether two entries can ever name the same file: globs overlap if either
// directory contains the other; a glob and a path overlap if it's under it.
// Glob-ness is read off the raw entry, before any unescaping: an escaped
// literal `dir/\*\*` unescapes to `dir/**`, and treating that as a directory
// glob would widen a one-file claim into a whole-subtree one.
function entriesOverlap(a: string, b: string): boolean {
  const aGlob = a.endsWith(GLOB_SUFFIX);
  const bGlob = b.endsWith(GLOB_SUFFIX);
  if (aGlob && bGlob) {
    const dirA = unescapeGlobPath(globDir(a));
    const dirB = unescapeGlobPath(globDir(b));
    return pathUnderDir(dirA, dirB) || pathUnderDir(dirB, dirA);
  }
  const pathA = unescapeGlobPath(a);
  const pathB = unescapeGlobPath(b);
  if (aGlob) return pathUnderDir(pathB, unescapeGlobPath(globDir(a)));
  if (bGlob) return pathUnderDir(pathA, unescapeGlobPath(globDir(b)));
  return pathA === pathB;
}

/** Two tasks conflict when their write-sets intersect; empty means unknown. */
export function tasksConflict(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => entriesOverlap(pa, pb)));
}

// Like tasksConflict, but an empty claim means "hasn't touched anything
// yet" rather than "could touch anything" — it must never universally block.
export function claimConflictsWithWrites(
  claim: string[],
  writes: string[]
): boolean {
  if (claim.length === 0) return false;
  return tasksConflict(claim, writes);
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
