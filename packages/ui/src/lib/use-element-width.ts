'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

// Width tracking for a host's own responsive switches (a board's sticky lane
// headers sized to its visible width, a page header that folds its toggles
// into a menu in a narrow column): one ResizeObserver per hook, on one element,
// reading the element's `clientWidth` (its padding box less a scrollbar).

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The element to measure: the element itself (from a callback ref kept in
    state, so a new element resubscribes), or a ref object read once when the
    hook subscribes after mount (its element must not change after that). */
export type ElementWidthTarget =
  | Element
  | null
  | { readonly current: Element | null };

export interface ElementWidthOptions {
  /** Measure once in a layout effect, before the first paint, as well as on
      every resize: a narrow column never flashes the wide layout. Without it
      the first answer is the observer's first callback (browsers fire one on
      `observe`, before that frame paints), so a render that is never laid out
      (a test, a server) keeps the starting answer. Default false. */
  measureOnMount?: boolean;
}

/** True for a ref object (`{ current }`), false for an element or null. A
    property test rather than `instanceof Element`, so an element from another
    window (an iframe's) still counts as one. */
function isRefObject(
  target: ElementWidthTarget
): target is { readonly current: Element | null } {
  return target !== null && 'current' in target;
}

/**
 * Subscribes `report` to `target`'s `clientWidth`: on mount when
 * `measureOnMount`, then on every ResizeObserver callback, through one
 * observer that disconnects on unmount or when the target changes. A box with
 * no width (not laid out yet, or `display: none` under a hidden Activity) is
 * not reported, so the last answer holds until it shows again. Nothing runs
 * on a server or where ResizeObserver is missing (but `measureOnMount` still
 * takes its one measure).
 */
function useObservedWidth(
  target: ElementWidthTarget,
  report: (width: number) => void,
  measureOnMount: boolean
): void {
  useClientLayoutEffect(() => {
    const element = isRefObject(target) ? target.current : target;
    if (element === null) return undefined;
    const measure = (): void => {
      const width = element.clientWidth;
      if (width > 0) report(width);
    };
    if (measureOnMount) measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, report, measureOnMount]);
}

/** `target`'s width in CSS pixels (its `clientWidth`), kept current as it
    resizes; `null` until it is first measured (always on a server). A host
    that only switches at a breakpoint wants `useWidthBelow`, which re-renders
    only when the answer flips. */
export function useElementWidth(
  target: ElementWidthTarget,
  options: ElementWidthOptions = {}
): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useObservedWidth(target, setWidth, options.measureOnMount ?? false);
  return width;
}

/** Whether `target`'s width (its `clientWidth`) is under `px`, kept current
    as it resizes; false (wide) until it is first measured, and on a server.
    The host re-renders only when the answer flips, not on every pixel. */
export function useWidthBelow(
  target: ElementWidthTarget,
  px: number,
  options: ElementWidthOptions = {}
): boolean {
  const [below, setBelow] = useState(false);
  const report = useCallback((width: number) => setBelow(width < px), [px]);
  useObservedWidth(target, report, options.measureOnMount ?? false);
  return below;
}
