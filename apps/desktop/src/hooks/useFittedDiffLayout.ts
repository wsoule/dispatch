import { type RefObject, useLayoutEffect, useState } from 'react';

import type { DiffLayout } from '../lib/diffDisplay';
import { useDiffDisplaySettings } from './useDiffDisplaySettings';

/**
 * The narrowest diff frame that still draws the reviewer's split layout, measured on the review
 * page: Pierre gives each side half the frame, less its 41px line-number gutter and about 16px
 * of change bar and padding, and sets code in 12px Geist Mono at 7.2px a column. At 980px each
 * side holds about 60 columns. The review page's diff column is 702px at the e2e suite's 1036px
 * window and 530px at 1600px (beside the review checklist and the properties rail), where split
 * left each side 31 to 43 columns: ordinary lines were cut mid-token and a finding hung on one
 * side got a sliver of it. Below this width a review diff draws unified instead.
 */
export const SPLIT_MIN_WIDTH = 980;

/**
 * Whether the frame `frameRef` points at is at least `SPLIT_MIN_WIDTH` wide, or null until it
 * has been measured. Read in a layout effect, so the answer is known before the first paint,
 * and again whenever the frame changes size (the window, a rail opening or closing), where
 * `ResizeObserver` exists. A width of 0 means the frame is not laid out (hidden, or a test
 * document with no layout) and decides nothing: the first reading then counts as fitting, so
 * the reviewer's setting stands, and a later 0 keeps the last answer. The frame's width is set
 * by the page around it, never by the diff inside, so the layout cannot feed back into it.
 */
function useFitsSplit(frameRef: RefObject<HTMLElement | null>): boolean | null {
  const [fits, setFits] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return undefined;
    const first = frame.clientWidth;
    setFits(first === 0 || first >= SPLIT_MIN_WIDTH);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const width = frame.clientWidth;
      if (width > 0) setFits(width >= SPLIT_MIN_WIDTH);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);
  return fits;
}

/**
 * The layout a review diff in `frameRef`'s frame draws: the reviewer's setting (Settings >
 * Diffs), except that split becomes unified while the frame is narrower than
 * `SPLIT_MIN_WIDTH`, and comes back on its own once it is wide enough again. A unified setting
 * is always unified. Null until the frame has been measured, so a caller mounts its diff only
 * once the layout is known: Pierre then lays the diff out once, in the right layout, instead
 * of split first and unified straight after. The frame must be rendered whenever the hook is,
 * since the reading happens once, when the component mounts.
 */
export function useFittedDiffLayout(
  frameRef: RefObject<HTMLElement | null>
): DiffLayout | null {
  const [display] = useDiffDisplaySettings();
  const fits = useFitsSplit(frameRef);
  if (fits === null) return null;
  return display.layout === 'split' && !fits ? 'unified' : display.layout;
}
