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

// One entry reduced to what comparison needs: whether it is a directory glob,
// and the unescaped path it turns on — the glob's directory, or the file
// itself. Computed once per entry rather than once per pair, since the
// scheduler compares whole write-sets against each other.
interface Entry {
  glob: boolean;
  key: string;
}

// Glob-ness is read off the raw entry, before any unescaping: an escaped
// literal `dir/\*\*` unescapes to `dir/**`, and treating that as a directory
// glob would widen a one-file claim into a whole-subtree one.
function toEntry(raw: string): Entry {
  const glob = raw.endsWith(GLOB_SUFFIX);
  return { glob, key: unescapeGlobPath(glob ? globDir(raw) : raw) };
}

// Whether two entries can ever name the same file: globs overlap if either
// directory contains the other; a glob and a path overlap if it's under it.
function entriesOverlap(a: Entry, b: Entry): boolean {
  if (a.glob && b.glob) {
    return pathUnderDir(a.key, b.key) || pathUnderDir(b.key, a.key);
  }
  if (a.glob) return pathUnderDir(b.key, a.key);
  if (b.glob) return pathUnderDir(a.key, b.key);
  return a.key === b.key;
}

/** Two tasks conflict when their write-sets intersect; empty means unknown. */
export function tasksConflict(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const entriesB = b.map(toEntry);
  return a
    .map(toEntry)
    .some((ea) => entriesB.some((eb) => entriesOverlap(ea, eb)));
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
