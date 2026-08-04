import { useCallback, useSyncExternalStore } from 'react';

import {
  DEFAULT_DIFF_DISPLAY_SETTINGS,
  DIFF_DISPLAY_CHANGED_EVENT,
  DIFF_DISPLAY_STORAGE_KEY,
  type DiffDisplaySettings,
  parseDiffDisplaySettings,
  serializeDiffDisplaySettings,
} from '../lib/diffDisplay';

// `useSyncExternalStore` requires `getSnapshot` to return a referentially stable value when
// nothing has changed — returning a freshly-parsed object every call would make React think the
// store changes on every render and re-render in a loop. This cache re-parses only when the raw
// localStorage string differs from the last read.
let cachedRaw: string | null | undefined;
let cachedSettings: DiffDisplaySettings = DEFAULT_DIFF_DISPLAY_SETTINGS;

function readSettings(): DiffDisplaySettings {
  if (typeof window === 'undefined') return DEFAULT_DIFF_DISPLAY_SETTINGS;
  const raw = window.localStorage.getItem(DIFF_DISPLAY_STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSettings = parseDiffDisplaySettings(raw);
  }
  return cachedSettings;
}

// Persists a write and re-broadcasts it as a same-window event. `storage` events are the
// browser's own cross-tab signal, but they never fire in the tab that made the write — every
// diff surface mounted in *this* window (Settings plus however many open diffs) needs to hear
// about the change too, hence the custom event alongside the native one.
function writeSettings(settings: DiffDisplaySettings): void {
  window.localStorage.setItem(
    DIFF_DISPLAY_STORAGE_KEY,
    serializeDiffDisplaySettings(settings)
  );
  window.dispatchEvent(new Event(DIFF_DISPLAY_CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', onChange);
  window.addEventListener(DIFF_DISPLAY_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(DIFF_DISPLAY_CHANGED_EVENT, onChange);
  };
}

/**
 * Shared diff display preferences (layout, indicators, backgrounds, line numbers), read from
 * `localStorage` and kept in sync across every mounted diff surface in this window. Changing a
 * setting anywhere — currently just the Settings view — updates every open `PierreReviewDiff`,
 * `RunDiffView`, and `GitDiffPane` immediately, with no remount required.
 */
export function useDiffDisplaySettings(): [
  DiffDisplaySettings,
  (patch: Partial<DiffDisplaySettings>) => void,
] {
  const settings = useSyncExternalStore(
    subscribe,
    readSettings,
    () => DEFAULT_DIFF_DISPLAY_SETTINGS
  );

  const update = useCallback((patch: Partial<DiffDisplaySettings>) => {
    writeSettings({ ...readSettings(), ...patch });
  }, []);

  return [settings, update];
}
