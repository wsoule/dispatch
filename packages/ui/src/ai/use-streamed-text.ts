import { useEffect, useState } from 'react';

// How often the reveal advances, and the default reading speed when the caller doesn't
// pass `cps`. Kept slow enough to read as "typing" rather than a flash.
const TICK_MS = 40;
const DEFAULT_CPS = 45;

/** Extends `shown` by at least `charsPerTick` characters, then pushes the boundary
 * forward to the next whitespace so a tick never lands mid-word. Once `shown` has
 * caught up to `full` (or a tick's tail runs past the end), returns `full` verbatim. */
export function nextSlice(
  full: string,
  shown: string,
  charsPerTick: number
): string {
  if (shown.length >= full.length) return full;

  const step = Math.max(1, charsPerTick);
  let end = Math.min(full.length, shown.length + step);

  const isWordChar = (index: number) => index >= 0 && !/\s/.test(full[index]);
  while (end < full.length && isWordChar(end - 1) && isWordChar(end)) {
    end += 1;
  }

  return full.slice(0, end);
}

// True when the OS/browser asks for reduced motion. Checked at hook-call time (not
// just via CSS) so the reveal itself can skip straight to the full string.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export type UseStreamedTextOptions = {
  /** Reveal speed in characters per second. Defaults to 45. */
  cps?: number;
  /** Whether the reveal animation runs at all. Defaults to true; false (or reduced
   * motion) shows `full` immediately. */
  enabled?: boolean;
};

/** Reveals `full` progressively on a fixed interval, word-boundary-aware via
 * `nextSlice`. Restarts whenever `full`, `enabled`, or `cps` change, so swapping in a
 * new answer or flipping `enabled` off snaps cleanly rather than mid-word. Matches the
 * showcase's "Streaming Text" primitive. */
export function useStreamedText(
  full: string,
  opts?: UseStreamedTextOptions
): string {
  const cps = opts?.cps ?? DEFAULT_CPS;
  const enabled = (opts?.enabled ?? true) && !prefersReducedMotion();
  const [shown, setShown] = useState(() => (enabled ? '' : full));

  useEffect(() => {
    if (!enabled) {
      setShown(full);
      return;
    }

    setShown('');
    const charsPerTick = Math.max(1, Math.round((cps * TICK_MS) / 1000));
    const id = setInterval(() => {
      setShown((current) => nextSlice(full, current, charsPerTick));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [full, enabled, cps]);

  return shown;
}
