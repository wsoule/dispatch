import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dispatch:side-panel-notifications-v1';
const CHANGED_EVENT = 'dispatch:side-panel-notifications-changed';

// Stored as 'hidden' only once someone turns the list off, so a missing or
// unreadable key reads as the original behaviour: notifications shown.
function readShown(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

// Persists the choice and re-broadcasts it in this window, since the native
// `storage` event only reaches other windows — the side panel and Settings
// both need to hear a change made in either.
function writeShown(shown: boolean): void {
  try {
    if (shown) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, 'hidden');
  } catch {
    // Storage is unavailable, so the choice cannot be kept.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED_EVENT, onChange);
  };
}

/**
 * Whether the side panel's Coming in column lists the notification history.
 * A viewing preference kept in localStorage, not project config: hiding the
 * list changes nothing about what is recorded or delivered, and the Inbox page
 * still has every entry.
 */
export function useSidePanelNotifications(): [
  boolean,
  (shown: boolean) => void,
] {
  const shown = useSyncExternalStore(subscribe, readShown, () => true);
  const setShown = useCallback((next: boolean) => writeShown(next), []);
  return [shown, setShown];
}
