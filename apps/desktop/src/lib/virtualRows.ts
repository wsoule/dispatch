import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';

// The pure half of the virtual-list primitive (`components/virtual/VirtualRows.tsx`):
// flattening grouped data into one row array, key lookups, and the windowing rules that
// decide which rows stay mounted. Kept free of React and the DOM so the math is testable
// without a layout engine.

/** One row of a flattened, grouped list: a group's header, or one of its items. */
export type FlatRow<H, I> =
  | {
      kind: 'header';
      key: string;
      groupKey: string;
      header: H;
      collapsed: boolean;
    }
  | { kind: 'item'; key: string; groupKey: string; item: I };

export interface RowGroup<H, I> {
  key: string;
  /** `null` draws no header row — a single ungrouped run of items. */
  header: H | null;
  items: readonly I[];
}

/** A header row's key. Prefixed so it can never collide with an item's own id. */
export function headerRowKey(groupKey: string): string {
  return `group:${groupKey}`;
}

/**
 * Groups → one flat row array: each group's header row (when it has one) followed by its
 * items, a collapsed group keeping only its header. One array means one virtualizer, and
 * a header scrolls with its items instead of being a separate sticky layer.
 */
export function flattenGroups<H, I>(
  groups: readonly RowGroup<H, I>[],
  collapsed: ReadonlySet<string>,
  itemKey: (item: I) => string
): FlatRow<H, I>[] {
  const rows: FlatRow<H, I>[] = [];
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.key);
    if (group.header !== null) {
      rows.push({
        kind: 'header',
        key: headerRowKey(group.key),
        groupKey: group.key,
        header: group.header,
        collapsed: isCollapsed,
      });
    }
    if (isCollapsed && group.header !== null) continue;
    for (const item of group.items) {
      rows.push({
        kind: 'item',
        key: itemKey(item),
        groupKey: group.key,
        item,
      });
    }
  }
  return rows;
}

/** Row key → index, built once per row array so a keyboard move is a map lookup. */
export function indexByKey<R>(
  rows: readonly R[],
  rowKey: (row: R) => string
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) map.set(rowKey(rows[i]), i);
  return map;
}

/**
 * A `rangeExtractor` that keeps `pinned` indexes mounted on top of the visible window —
 * the card being dragged (dnd-kit loses a draggable whose node unmounts mid-drag) and the
 * keyboard cursor's row (the grid's `aria-activedescendant` must point at a real node).
 * Out-of-range pins are dropped; the result is sorted and duplicate-free.
 */
export function pinnedRangeExtractor(
  pinned: readonly number[]
): (range: Range) => number[] {
  if (pinned.length === 0) return defaultRangeExtractor;
  return (range) => {
    const base = defaultRangeExtractor(range);
    const first = base[0] ?? 0;
    const last = base[base.length - 1] ?? -1;
    const extra = pinned.filter(
      (i) => i >= 0 && i < range.count && (i < first || i > last)
    );
    if (extra.length === 0) return base;
    return [...new Set([...base, ...extra])].sort((a, b) => a - b);
  };
}

export interface ViewportRect {
  width: number;
  height: number;
}

/** What an unmeasured viewport windows as. */
export const UNMEASURED_VIEWPORT: ViewportRect = { width: 1280, height: 960 };

/**
 * A 0×0 scroll viewport has not been laid out — or never will be, in a DOM without layout
 * (the component tests). Windowing it as zero rows would render nothing at all, so it
 * windows as a typical screen instead: a bounded row count, never the whole list.
 */
export function viewportOrFallback(rect: ViewportRect): ViewportRect {
  return rect.width === 0 && rect.height === 0 ? UNMEASURED_VIEWPORT : rect;
}

/**
 * Whether a track spanning `[trackStart, trackStart + trackSize)` of the scroller's content
 * is within one viewport of the visible window. The windowing engine keeps a track's edge
 * rows mounted even when the whole track is far off screen — harmless for one list, but a
 * board has a track per lane and status, so the ones nowhere near the viewport render only
 * their pinned rows instead.
 */
export function trackNearViewport(
  trackStart: number,
  trackSize: number,
  scrollOffset: number,
  viewportSize: number
): boolean {
  return (
    trackStart + trackSize >= scrollOffset - viewportSize &&
    trackStart <= scrollOffset + 2 * viewportSize
  );
}

/**
 * The board's columns within `margin` (a share of the visible width) of the visible range,
 * by index, from each column's `[left, right]` span in the scrolled content. `null` — every
 * column near — while there is nothing to measure against (no width, no columns), as in a
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

/** Whether two `nearColumnIndexes` results hold the same columns. */
export function sameColumnIndexes(
  a: ReadonlySet<number> | null,
  b: ReadonlySet<number> | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const index of a) if (!b.has(index)) return false;
  return true;
}

/** The key `delta` steps from `current` along `keys`, clamped to the ends; the first key
 * when nothing is focused yet, `null` for an empty list. */
export function stepKey(
  keys: readonly string[],
  current: string | null,
  delta: number
): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at === -1) return keys[0] ?? null;
  const next = Math.min(Math.max(at + delta, 0), keys.length - 1);
  return keys[next] ?? null;
}
