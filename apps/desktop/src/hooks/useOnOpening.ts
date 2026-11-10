import { useState } from 'react';

/**
 * Calls `onOpening` during the render in which `open` turns true, not in an effect after the
 * commit, so whatever it changes commits together with the opening. App closes the task
 * composer this way as Settings opens: the composer's modal SlideOver hands focus back to its
 * opener in that same commit, before DispatchShell moves focus into the Settings page (and
 * remembers that opener for when Settings closes). Run from an effect instead, the composer
 * would close one commit later and pull focus back out of Settings, onto its opener in a view
 * Settings hides.
 *
 * `onOpening` runs during render, so it may only set state owned by the component that calls
 * this hook (React re-renders that component before committing). It does not run when `open`
 * is already true on the first render.
 */
export function useOnOpening(open: boolean, onOpening: () => void): void {
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) onOpening();
  }
}
