// The board's sideways windowing: which status columns sit near the board's horizontal
// viewport. A column away from it hands `useRowWindows` an `offscreen` group, so a
// vertical scroll mounts cards only in the columns in and beside the window. Kept free of
// React and the DOM so the span math is testable without a layout engine.

/**
 * The board's columns within `margin` (a share of the visible width) of the visible range,
 * by index, from each column's `[left, right]` span in the scrolled content. `null` (every
 * column near) while there is nothing to measure against (no width, no columns), as in a
 * DOM without layout.
 */
export function nearColumnIndexes(
  spans: readonly (readonly [number, number])[],
  scrollLeft: number,
  width: number,
  margin: number
): ReadonlySet<number> | null {
  if (width <= 0 || spans.length === 0) return null;
  const from = scrollLeft - width * margin;
  const to = scrollLeft + width * (1 + margin);
  const near = new Set<number>();
  spans.forEach(([left, right], index) => {
    if (right >= from && left <= to) near.add(index);
  });
  return near;
}

/**
 * Whether two `nearColumnIndexes` results hold the same columns, so a sideways scroll that
 * moves no column in or out of range sets no state.
 */
export function sameColumnIndexes(
  a: ReadonlySet<number> | null,
  b: ReadonlySet<number> | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const index of a) if (!b.has(index)) return false;
  return true;
}
