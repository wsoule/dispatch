import { useSyncExternalStore } from 'react';

// The height of the bulk bar on screen, in px, or null while none is up.
// BulkBar measures itself and publishes it here; what has to clear the bar
// reads it with useBulkBarHeight and sets it on its own element: the toast
// stack (ToastProvider puts --bulk-bar-h on its viewport) and a host's list
// (its bottom room). It used to be a custom property on <html>, which every
// element inherits, so the first selection and clearing it restyled the
// whole page: 0.5-0.7 s on a 300-row list (the showcase's /issues).

let height: number | null = null;
const listeners = new Set<() => void>();

/** Sets the published height (null: no bar is up) and tells the readers,
    only when it changed. */
export function publishBulkBarHeight(next: number | null): void {
  if (next === height) return;
  height = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): number | null {
  return height;
}

function readOnServer(): null {
  return null;
}

/** The bulk bar's height in px while one is up, else null (always null on
    the server and in the hydration render). */
export function useBulkBarHeight(): number | null {
  return useSyncExternalStore(subscribe, read, readOnServer);
}
