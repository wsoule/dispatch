/**
 * Which epic lanes are folded up on the board.
 *
 * Session-scoped on purpose: collapsing an epic is a "get this out of my way while I look at
 * something else" gesture, not a preference worth surviving a restart — reopening the app to a
 * board with half its work hidden, and no memory of having hidden it, is worse than re-collapsing.
 * `sessionStorage` gives exactly that lifetime, and keeps the state across view-mode switches and
 * nav trips away from Tasks (which plain component state would lose).
 *
 * The set holds the *collapsed* lanes rather than the expanded ones, so an epic created after the
 * user collapsed something starts expanded — the default is "show me the work".
 */
export const COLLAPSED_EPICS_STORAGE_KEY = 'dispatch:board-collapsed-epics';

/** Tolerates anything that isn't a JSON array of strings — a corrupt or hand-edited value means
 * "nothing is collapsed", never a thrown render. */
export function parseCollapsedEpics(stored: string | null): Set<string> {
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
export function serializeCollapsedEpics(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].sort());
}

/** Returns a new set with `key` flipped — the state update itself, kept pure and out of the
 * component so the toggle can be tested without rendering a board. */
export function toggleCollapsedEpic(
  keys: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}
