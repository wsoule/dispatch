import { useCallback, useEffect, useRef, useState } from 'react';

// A pane can never be dragged narrower than this — below it, list rows and controls stop
// being usable.
const MIN_WIDTH_PX = 220;
// ...nor wider than half of whatever the split container currently measures, so the detail
// pane next to it always keeps at least half the available space.
const MAX_WIDTH_RATIO = 0.5;

/**
 * Hand-rolled pointer-based resize for a fixed-width pane that sits beside a flexible one
 * (e.g. the Runs list column next to the run detail view). No drag library — just
 * pointerdown/move/up with `setPointerCapture` so the drag keeps tracking even if the cursor
 * leaves the handle. Width is clamped between `MIN_WIDTH_PX` and half of `containerRef`'s
 * current width, persisted to localStorage under `storageKey`, and resets to `defaultWidth`
 * on double-click.
 */
export function useResizablePane(
  storageKey: string,
  defaultWidth: number,
  containerRef: React.RefObject<HTMLElement | null>
) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
  });
  // Pointer-drag origin: the width and cursor x when the drag started, so `onPointerMove`
  // can compute an absolute new width from the total delta rather than accumulating
  // per-event drift.
  const dragOrigin = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const clamp = useCallback(
    (value: number) => {
      const containerWidth = containerRef.current?.clientWidth ?? Infinity;
      const max = Math.max(MIN_WIDTH_PX, containerWidth * MAX_WIDTH_RATIO);
      return Math.min(Math.max(value, MIN_WIDTH_PX), max);
    },
    [containerRef]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragOrigin.current = { x: e.clientX, width };
    },
    [width]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragOrigin.current === null) return;
      setWidth(
        clamp(dragOrigin.current.width + (e.clientX - dragOrigin.current.x))
      );
    },
    [clamp]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragOrigin.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onDoubleClick = useCallback(
    () => setWidth(defaultWidth),
    [defaultWidth]
  );

  return { width, onPointerDown, onPointerMove, onPointerUp, onDoubleClick };
}
