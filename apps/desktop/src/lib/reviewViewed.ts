/**
 * Which files you have already read in a run's review.
 *
 * Stored in localStorage rather than with the run, because this is a reading aid belonging to
 * one person at one desk — not a fact about the work. Two people reviewing the same branch have
 * genuinely different answers, and syncing it to the repo would make one of them wrong.
 *
 * Keyed by run so reopening a review picks up where you left off, and so a re-dispatch of the
 * same task starts clean rather than inheriting ticks from a diff that no longer exists.
 */

function key(runId: string): string {
  return `dispatch:review-viewed:${runId}`;
}

export function readViewed(runId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key(runId));
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    // A hand-mangled or half-written entry degrades to "nothing read yet", which costs the
    // reader a re-read at worst. Throwing here would take the whole review surface down.
    return new Set();
  }
}

export function writeViewed(runId: string, viewed: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(runId), JSON.stringify([...viewed]));
  } catch {
    // Storage full or blocked. Losing the ticks is survivable; failing the click is not.
  }
}

export function toggleViewed(
  viewed: ReadonlySet<string>,
  path: string
): Set<string> {
  const next = new Set(viewed);
  if (!next.delete(path)) next.add(path);
  return next;
}

/** "3 of 7 viewed" — the readout that makes a long review feel finite. */
export function viewedSummary(
  viewed: ReadonlySet<string>,
  paths: readonly string[]
): string {
  // Counted against the files actually in this diff, not against everything ever ticked: a file
  // that dropped out of the diff should not inflate the numerator past the denominator.
  const seen = paths.filter((p) => viewed.has(p)).length;
  return `${seen} of ${paths.length} viewed`;
}
