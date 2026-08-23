import { useCallback, useState } from 'react';

/** The one brain-dump draft, shared by the full view and the ⌘B quick-capture
 * modal — leaving either surface must not cost half-typed thoughts. */
export const BRAIN_DUMP_DRAFT_KEY = 'dispatch:brain-dump-draft';

/**
 * Draft text that survives navigation and relaunch, mirrored to localStorage
 * on every change. An empty draft removes the key rather than storing ''.
 */
export function usePersistedDraft(
  key: string
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(key) ?? '';
  });
  const set = useCallback(
    (next: string) => {
      setDraft(next);
      try {
        if (next === '') window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, next);
      } catch {
        // Storage full or denied costs persistence, not typing.
      }
    },
    [key]
  );
  return [draft, set];
}
