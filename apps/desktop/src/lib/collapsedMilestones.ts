/**
 * Which groups are folded up — swim lanes on the board (milestone, assignee or priority lanes,
 * whichever the display's sub-grouping picks), status/milestone/milestone groups in the list,
 * milestones on the Milestones page.
 *
 * Session-scoped on purpose: collapsing a group is a "get this out of my way while I look at
 * something else" gesture, not a preference worth surviving a restart — reopening the app to a
 * board with half its work hidden, and no memory of having hidden it, is worse than re-collapsing.
 * `sessionStorage` gives exactly that lifetime, and keeps the state across view-mode switches and
 * nav trips away from Tasks (which plain component state would lose).
 *
 * The set holds the *collapsed* groups rather than the expanded ones, so a group created after the
 * user collapsed something starts expanded — the default is "show me the work".
 */
/** The board's lanes, whatever kind they are. Keys are namespaced by lane kind (`e-…` /
 * `__no-milestone__` for milestone lanes, `assignee:…`, `priority:…`) so a fold on one sub-grouping
 * never hides a lane of another. The storage key predates the generalized lanes, so sessions
 * folded before it survive. */
export const COLLAPSED_LANES_STORAGE_KEY =
  'dispatch:board-collapsed-milestones';
/** The list's groups, keyed by `ListGroup.key` (`status:ready`, `milestone:e-1`, …). */
export const COLLAPSED_GROUPS_STORAGE_KEY = 'dispatch:list-collapsed-groups';
/** The Milestones page's folds. Its own key because a stored milestone there means "flipped
 * from its default" (finished ones start folded), not "collapsed" as the list's key does. */
export const TOGGLED_MILESTONES_STORAGE_KEY = 'dispatch:milestones-toggled';

/** Tolerates anything that isn't a JSON array of strings — a corrupt or hand-edited value means
 * "nothing is collapsed", never a thrown render. */
export function parseCollapsedGroups(stored: string | null): Set<string> {
  if (stored === null || stored === '') return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Sorted so the stored value is stable for a given set — makes the storage write idempotent and
 * the test assertions order-independent. */
export function serializeCollapsedGroups(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].sort());
}

/** Returns a new set with `key` flipped — the state update itself, kept pure and out of the
 * component so the toggle can be tested without rendering a board. */
export function toggleCollapsedGroup(
  keys: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Reads the collapsed set from `sessionStorage` under `key`, tolerating a missing or blocked
 * store (a render must never throw over a preference). */
export function readCollapsedGroups(key: string): Set<string> {
  try {
    return parseCollapsedGroups(window.sessionStorage.getItem(key));
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(
  key: string,
  keys: ReadonlySet<string>
): void {
  try {
    window.sessionStorage.setItem(key, serializeCollapsedGroups(keys));
  } catch {
    // A blocked store just means the fold does not survive a view switch.
  }
}
