// Persistence for TaskGroupTable's folded groups. The stored value is the
// set of COLLAPSED group ids (not the expanded ones), so a group that
// appears after the user folded something starts expanded: the default is
// "show me the work". Every storage access tolerates a missing or blocked
// store (private mode, Tauri without storage): a preference never throws.

export type CollapsedStorage = 'local' | 'session';

/** Parses a stored value; anything but a JSON array of strings means "none". */
export function parseCollapsed(stored: string | null): Set<string> {
  if (stored === null || stored === '') return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Sorted, so the same set always serialises to the same string. */
export function serializeCollapsed(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

function storageOf(kind: CollapsedStorage): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

/** The raw stored string, or null when nothing (readable) is stored. A
 * string, not a Set, so useSyncExternalStore gets a stable snapshot. */
export function readCollapsedRaw(
  key: string,
  kind: CollapsedStorage
): string | null {
  try {
    return storageOf(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

// In-page subscribers: the 'storage' event only fires in OTHER documents,
// so writes from this page notify mounted tables directly.
const listeners = new Set<() => void>();

/** useSyncExternalStore subscription: this page's writes + other tabs'. */
export function subscribeCollapsed(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function writeCollapsed(
  key: string,
  kind: CollapsedStorage,
  ids: ReadonlySet<string>
): void {
  try {
    storageOf(kind)?.setItem(key, serializeCollapsed(ids));
  } catch {
    /* blocked storage: the fold simply does not persist */
  }
  for (const listener of listeners) listener();
}

/** Returns a new set with `id` flipped; pure so the toggle is testable. */
export function toggleCollapsed(
  ids: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}
