// The task-status vocabulary — the pipeline, in the same word family as the
// app's whose-move feed states, so board columns and feed rows speak one
// language. Browser-safe: no node:* imports (re-exported to the webview).
//
// Draft and Ready are the human columns (captured vs specified-enough-to-
// dispatch); Working/Review/Landing/Landed are machine-set as runs and the
// merge queue advance; Dropped is a deliberate "not doing it". "Landed" is
// what "done" always wanted to mean: merged, not merely finished.

export const CANONICAL_STATUSES = [
  'draft',
  'ready',
  'working',
  'review',
  'landing',
  'landed',
  'dropped',
] as const;

export type TaskStatus = (typeof CANONICAL_STATUSES)[number];

/**
 * The pre-rename names, mapped to their canonical successors. Applied at every
 * read boundary (task-file parse, config load) and write boundary
 * (store create/update), so task files written years ago and API callers
 * speaking the old names keep working forever without a migration pass —
 * files simply rewrite themselves in canonical form on their next touch.
 */
const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {
  backlog: 'draft',
  todo: 'ready',
  'in-progress': 'working',
  'in-review': 'review',
  done: 'landed',
  cancelled: 'dropped',
};

/** Canonical form of any status string. Unknown names pass through untouched —
 * `.dispatch/config.yml` may define custom statuses. */
export function canonicalStatus(raw: string): string {
  return LEGACY_STATUS_ALIASES[raw] ?? raw;
}

/** Column/label casing for a status, canonical or custom ("draft" -> "Draft"). */
export function statusLabel(status: string): string {
  const canonical = canonicalStatus(status);
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

/** Terminal: the task's story is over, by merge or by choice. */
export function isDoneStatus(status: string): boolean {
  const s = canonicalStatus(status);
  return s === 'landed' || s === 'dropped';
}

/**
 * Whether a blocker no longer holds up *dispatching* its dependents. Looser
 * than done: a dependent can start as soon as the blocker's code exists on a
 * branch, which is `review` — and certainly once it is queued (`landing`).
 * The built-in statuses are the contract the orchestrator's own transitions
 * are written against, even though config allows custom names.
 */
export function isSatisfiedForDispatchStatus(status: string): boolean {
  const s = canonicalStatus(status);
  return isDoneStatus(s) || s === 'review' || s === 'landing';
}
