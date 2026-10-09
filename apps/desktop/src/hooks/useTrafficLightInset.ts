import { useEffect, useState } from 'react';

import { isTauri } from '../lib/tauri';

/** True on the packaged macOS app, where the window uses `titleBarStyle: "Overlay"` and the
 * native traffic lights float over the top-left of the top bar, so it needs a left inset. In a
 * plain browser (dev harness) or on Linux there are no overlaid controls to dodge. */
function isMacTauri(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh')
  );
}

/** Whether to reserve space for the macOS traffic lights. They auto-hide in native
 * fullscreen, so the inset collapses there; fullscreen is re-checked on every window resize
 * (entering/leaving fullscreen always resizes, and `isFullscreen` is the reliable signal). */
export function useTrafficLightInset(): boolean {
  const [inset, setInset] = useState(() => isMacTauri());

  useEffect(() => {
    if (!isMacTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const update = async () => {
        const fullscreen = await win.isFullscreen();
        if (!cancelled) setInset(!fullscreen);
      };
      void update();
      const stop = await win.onResized(() => void update());
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return inset;
}
