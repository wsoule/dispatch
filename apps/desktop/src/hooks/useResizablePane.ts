import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

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
  // Track whether a drag is currently active to avoid persisting on every pointermove frame.
  const isDragging = useRef(false);

  // After mount, re-clamp the restored width against the live container width in case a
  // previously-persisted wide value exceeds the max-50%-of-container invariant. Runs once
  // on mount; intentionally excludes width and containerRef from deps to run only at mount.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const containerWidth = containerRef.current?.clientWidth;
    if (containerWidth) {
      const max = Math.max(MIN_WIDTH_PX, containerWidth * MAX_WIDTH_RATIO);
      const clamped = Math.min(Math.max(width, MIN_WIDTH_PX), max);
      if (clamped !== width) {
        setWidth(clamped);
      }
    }
  }, []);

  // Persist width to localStorage, but skip during active drag to avoid hammering storage
  // on every pointermove frame. Drag release and non-drag setters will still persist.
  useEffect(() => {
    if (!isDragging.current) {
      window.localStorage.setItem(storageKey, String(width));
    }
  }, [storageKey, width]);

  const clamp = useCallback(
    (value: number) => {
      const containerWidth = containerRef.current?.clientWidth ?? Infinity;
      const max = Math.max(MIN_WIDTH_PX, containerWidth * MAX_WIDTH_RATIO);
      return Math.min(Math.max(value, MIN_WIDTH_PX), max);
    },
    [containerRef]
  );

  // Same ceiling `clamp` uses, exposed standalone so callers can report it as
  // `aria-valuemax` without duplicating the container-width-to-max math.
  const maxWidth = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? Infinity;
    return Math.max(MIN_WIDTH_PX, containerWidth * MAX_WIDTH_RATIO);
  }, [containerRef]);

  // Persists a width the same way a drag release does — used by both
  // `endDrag` and the keyboard handler below, so Arrow/Home/End presses
  // survive a reload exactly like a mouse-drag resize does.
  const persistWidth = useCallback(
    (value: number) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, String(value));
      }
    },
    [storageKey]
  );

  // Keyboard operability for the drag handle: ArrowLeft/ArrowRight nudge the
  // width by 16px (clamped to the same min/max a drag would respect), Home
  // snaps to the minimum, End snaps to the maximum. Each keypress persists
  // immediately, mirroring a drag's persist-on-release behavior since there's
  // no separate "release" event for a keypress.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const ARROW_STEP_PX = 16;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') {
        next = clamp(width - ARROW_STEP_PX);
      } else if (e.key === 'ArrowRight') {
        next = clamp(width + ARROW_STEP_PX);
      } else if (e.key === 'Home') {
        next = clamp(MIN_WIDTH_PX);
      } else if (e.key === 'End') {
        next = clamp(maxWidth());
      }
      if (next === null) return;
      e.preventDefault();
      setWidth(next);
      persistWidth(next);
    },
    [width, clamp, maxWidth, persistWidth]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      isDragging.current = true;
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

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isDragging.current = false;
      dragOrigin.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      // Explicitly persist the final width after drag release.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, String(width));
      }
    },
    [storageKey, width]
  );

  const onPointerUp = endDrag;
  const onPointerCancel = endDrag;

  const onDoubleClick = useCallback(
    () => setWidth(clamp(defaultWidth)),
    [defaultWidth, clamp]
  );

  return {
    width,
    minWidth: MIN_WIDTH_PX,
    maxWidth: maxWidth(),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onDoubleClick,
    onKeyDown,
  };
}
