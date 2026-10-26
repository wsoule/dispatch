import { useEffect, useRef, useState } from 'react';

// How often the reveal advances, and the default reading speed when the caller doesn't
// pass `cps`. Kept slow enough to read as "typing" rather than a flash.
const TICK_MS = 40;
const DEFAULT_CPS = 45;
// The most ticks the reveal may trail the text by: a burst that arrives faster than
// `cps` is revealed in this many ticks instead, so the reveal never falls behind the
// stream it is showing.
const CATCH_UP_TICKS = 6;

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

/** How many characters each tick reveals once the text has grown to leave `behind`
 * characters hidden: the `cps` reading speed, or more when that would take longer than
 * CATCH_UP_TICKS ticks, so a burst of text is shown within about a quarter second. */
export function revealStep(behind: number, cps: number): number {
  const base = Math.max(1, Math.round((cps * TICK_MS) / 1000));
  return Math.max(base, Math.ceil(behind / CATCH_UP_TICKS));
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

/** Reveals text as it streams in. The text a component mounts with is shown at once,
 * since it has already arrived and typing it out would fake a stream that never
 * happened. When `full` then grows by appending (a delta landed), the new tail is
 * revealed from wherever the reveal is, word-boundary-aware via `nextSlice` and never
 * more than CATCH_UP_TICKS ticks behind. Any other change (a different text, `enabled`
 * off, reduced motion) shows the new text whole. */
export function useStreamedText(
  full: string,
  opts?: UseStreamedTextOptions
): string {
  const cps = opts?.cps ?? DEFAULT_CPS;
  const enabled = (opts?.enabled ?? true) && !prefersReducedMotion();
  const [shown, setShown] = useState(full);
  // Worked out during render, so text that is not a continuation never flashes the
  // old reveal for a frame before the effects below catch up.
  const visible = enabled && full.startsWith(shown) ? shown : full;
  const behind = visible.length < full.length;
  // What the ticking reveal is heading for, and how fast: the speed is set each time
  // the text grows, from what was hidden at that moment, so the whole tail lands
  // within CATCH_UP_TICKS rather than slowing down as it shrinks.
  const target = useRef({ full, step: 1 });

  useEffect(() => {
    if (target.current.full !== full) {
      target.current = {
        full,
        step: revealStep(full.length - visible.length, cps),
      };
    }
    // Keeps the state on the text shown, so the next delta continues from it.
    if (!behind) setShown(full);
  }, [full, visible, behind, cps]);

  // One interval for as long as the reveal is behind, reading the latest text from
  // `target`. It is not restarted when the text grows: deltas often land faster than
  // a tick, and a timer reset by each of them would never fire.
  useEffect(() => {
    if (!behind) return;
    const id = setInterval(() => {
      setShown((current) => {
        const { full: text, step } = target.current;
        return nextSlice(text, text.startsWith(current) ? current : text, step);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [behind]);

  return visible;
}
