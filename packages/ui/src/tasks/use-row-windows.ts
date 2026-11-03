'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

import { useLatest } from '../edit/save-state';
import {
  heightOr,
  initialSegments,
  type RowSegment,
  sameSegments,
  sumHeights,
  windowSegments,
} from './row-window';
import type { TaskScrollParent } from './types';

// The DOM half of TaskGroupTable's row windowing, exported for a host's
// own grouped lists too (Dispatch's board columns, Live's bands). One
// measurement pass serves every group: on each scroll and resize, and
// before paint whenever the rows change (a fold, a refresh, a re-sort),
// the host's known heights change or the focused row is not drawn, it
// reads the scroll viewport, the sticky column header, each group's list
// position and the heights of the rows that are drawn, then asks
// row-window.ts which rows of each group to mount. A row's height is, in
// order: the host's exact height for it (the `rowHeight` option, for rows
// whose height the host computes, such as Live's bands, each a whole
// canvas; it wins over a measurement, so a row that grew or folded while
// it was away from the viewport stands at its new height at once), else
// its own measured height once drawn (a list's `li[data-row-id]` children,
// border box, so cards of different heights need no separate mode), else
// the running mean of the measured rows (the `estimate` option before the
// first measurement). So a gap's size, the scroll range and revealRow's
// target are exact from the first render when the host knows its heights,
// and settle as the list is scrolled when it does not. A known height
// never enters the running mean: only a real measurement does, and a row
// that leaves every group leaves the mean too.
//
// Why not one @tanstack/react-virtual instance per group: each would need
// its list's offset in the scroller as `scrollMargin`, which moves whenever
// an earlier group folds or a row above is measured, so the table would
// still have to re-measure every list on every scroll and feed forty
// virtualizer instances (forty scroll subscriptions, forty ResizeObservers).
// One pass over the same rects is less machinery, and it is testable with a
// stub of getBoundingClientRect alone.

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A row before any is measured: --row-h 40 + 7px padding above and below
    + the 1px divider. */
export const DEFAULT_ROW_PX = 55;
/** Rows kept mounted past each edge of the viewport, in row heights, unless
    the host passes `overscan`. */
const OVERSCAN_ROWS = 8;
/** Rows the first render draws before the first measurement, unless the
    host passes `initialRows`: the first groups in order, whole, until this
    many rows are drawn. */
const INITIAL_ROWS = 60;

/** One shown (unfolded) group: its id and its rows' ids, in order. */
export interface RowWindowGroup {
  id: string;
  rowIds: readonly string[];
  /** Scrolled out of view on the other axis (a board column off to the
      side): the group mounts none of its rows but the pinned ones (the
      focused row, the rows being dragged) and stands as gaps of its full
      height otherwise, so it costs nothing until it scrolls back. */
  offscreen?: boolean;
}

export interface RowWindows {
  /** The window of a shown group, or null to draw every row (windowing is
      off). */
  segmentsOf: (groupId: string) => RowSegment[] | null;
  /** Each group's <ul> registers itself here (a ref callback). */
  registerList: (groupId: string, el: HTMLUListElement | null) => void;
  /** Scrolls the least that puts the element whole in the viewport, under
      the sticky column header. */
  revealElement: (el: HTMLElement) => void;
  /** The same for a row that is not mounted (its place is computed from
      the rows before it), then mounts the rows there and focuses the row
      once it is in the DOM. */
  focusUnmountedRow: (groupId: string, index: number, rowId: string) => void;
  /** Scrolls an unmounted row into view without focusing it (its place
      is computed from the rows before it, as for focusUnmountedRow), then
      mounts the rows there. `align` 'nearest' (the default) scrolls the
      least that shows the row whole; 'start' puts the row's top at the
      viewport's top, under the sticky column header, wherever it was (a
      jump to a section, the way Live's J/K bring a band's title up). */
  revealRow: (
    groupId: string,
    index: number,
    align?: 'nearest' | 'start'
  ) => void;
  /** The row that has keyboard focus (kept mounted while the list scrolls
      away from it, so focus never falls to the body). A row that is not
      drawn when it takes the focus (a keyboard cursor moved into it) is
      mounted at once, and one that a re-sort moves away stays mounted. */
  setFocusedRow: (rowId: string | null) => void;
}

export interface RowWindowsOptions {
  /** The element that holds every list (the scroller is searched for from
      it when `scrollParent` is not given, and a row waiting for focus is
      found under it). */
  rootRef: { readonly current: HTMLElement | null };
  /** A sticky header over the lists, whose cover the band and the reveals
      keep clear of; a ref holding null when there is none. */
  headRef: { readonly current: HTMLElement | null };
  /** Off below the windowAbove threshold: every row is drawn. */
  enabled: boolean;
  scrollParent: TaskScrollParent | undefined;
  /** The shown groups in reading order. */
  groups: readonly RowWindowGroup[];
  /** Rows being dragged: kept mounted so the drag survives a scroll. */
  dragging: ReadonlySet<string>;
  /** The px a row takes before any row has been measured: the first
      render's gaps, and the gaps of rows never drawn until the first
      measurement. Default DEFAULT_ROW_PX (a list row); a board passes its
      card's height plus the space between cards. */
  estimate?: number;
  /** A row's exact height in px, by row id, or undefined when the host
      does not know it (0, a negative number and NaN count as unknown).
      For rows whose height the host computes (Live's bands: an empty
      band's head up to a whole canvas), so the gaps, the scroll range and
      revealRow are exact before every row was drawn. A row's height is
      read as: this, else measured once drawn, else the running mean of
      the measured rows, else `estimate`; the known height wins over a
      measurement, so the drawn row must be exactly that tall. Pass a
      stable function (a useCallback over the heights): a new one re-windows
      before paint, which is how a row that grows or folds reaches the gaps
      without a scroll. It is called for every row on each pass, so keep it
      a lookup. A known height never enters the running mean. */
  rowHeight?: (rowId: string) => number | undefined;
  /** How many rows the server render and the first client render draw
      before the first measurement (the first groups in order, whole,
      until this many rows are drawn; the rest are gaps). A whole number
      (a fraction is rounded down; below 0 or NaN draws none).
      Default 60 (INITIAL_ROWS), sized for list rows; a host whose rows are
      each a screen or more (Live's bands) passes a few. */
  initialRows?: number;
  /** Rows kept mounted past each edge of the viewport, in row heights.
      Default 8 (OVERSCAN_ROWS), sized for 55px list rows; a host with tall
      rows (a board's cards) passes fewer so the band stays about as many
      pixels deep. */
  overscan?: number;
  /** Renders a scroll's new windows inside the scroll event (flushSync),
      so the frame that scroll paints already holds the rows it brought
      into the band. Off by default: the windows render a task later, which
      a band of short rows hides. A host whose rows are tall and few per
      band (a board's cards, all its columns in one commit) turns it on. */
  flushOnScroll?: boolean;
  /** A value that changes when every row may have changed height at once
      without a window resize or a scroll (a list whose own width changed,
      so its rows rewrap or a container query stacks them into cards). On a
      change the measured heights are forgotten (a row that is not drawn
      then stands at the running mean of the drawn ones, which are measured
      again at once) and the windows are measured again before paint.
      Omit it (or keep it constant) for lists whose rows only change height
      with the viewport. */
  layoutKey?: string | number;
}

/** What the table scrolls in: an element, or the document (the window). */
type Scroller = { el: HTMLElement } | { el: null };
const WINDOW_SCROLLER: Scroller = { el: null };

/** The scroll container of `root`: the prop, else the nearest ancestor with
    overflow-y auto or scroll, else the window (the document's own scroll).
    A function prop that answers null (a host ref not attached yet: a
    parent's ref callback runs after this child's layout effect) falls back
    to the search, and is asked again in a passive effect. */
function resolveScroller(
  root: HTMLElement,
  prop: TaskScrollParent | undefined
): Scroller {
  if (prop === 'window') return WINDOW_SCROLLER;
  if (typeof prop === 'function') {
    const el = prop();
    if (el !== null) return { el };
  } else if (prop !== undefined) {
    return { el: prop };
  }
  for (
    let el = root.parentElement;
    el !== null && el !== document.body && el !== document.documentElement;
    el = el.parentElement
  ) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return { el };
  }
  return WINDOW_SCROLLER;
}

/** The viewport's top and bottom in client coordinates. */
function viewportOf(scroller: Scroller): { top: number; bottom: number } {
  if (scroller.el === null) return { top: 0, bottom: window.innerHeight };
  const rect = scroller.el.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** How far down from the viewport's top the sticky column header reaches
    (its sticky offset plus its height): rows under it are covered. */
function headCover(head: HTMLElement | null): number {
  if (head === null) return 0;
  const top = Number.parseFloat(getComputedStyle(head).top);
  return (Number.isFinite(top) ? top : 0) + head.getBoundingClientRect().height;
}

function scrollBy(scroller: Scroller, delta: number): void {
  if (delta === 0) return;
  if (scroller.el === null) window.scrollBy(0, delta);
  else scroller.el.scrollTop += delta;
}

export function useRowWindows({
  rootRef,
  headRef,
  enabled,
  scrollParent,
  groups,
  dragging,
  estimate: firstEstimate = DEFAULT_ROW_PX,
  rowHeight,
  initialRows = INITIAL_ROWS,
  overscan: overscanRows = OVERSCAN_ROWS,
  flushOnScroll = false,
  layoutKey,
}: RowWindowsOptions): RowWindows {
  // Group id → its window; null until the first measurement (the server and
  // the first client render draw initialSegments instead).
  const [windows, setWindows] = useState<ReadonlyMap<
    string,
    RowSegment[]
  > | null>(null);
  const scrollerRef = useRef<Scroller | null>(null);
  const lists = useRef(new Map<string, HTMLUListElement>()).current;
  // Measured row heights by row id (they outlive the row's mount, standing
  // in for it in a gap), and their running mean for rows never drawn.
  const heights = useRef(new Map<string, number>()).current;
  const measured = useRef({ sum: 0, n: 0 }).current;
  const focusedRow = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const latest = useLatest({
    groups,
    dragging,
    windows,
    enabled,
    flushOnScroll,
    rowHeight,
  });

  const estimate = useCallback(
    () => (measured.n > 0 ? measured.sum / measured.n : firstEstimate),
    [measured, firstEstimate]
  );

  // A row's height by id: the host's exact height (rowHeight, read through
  // `latest` so this callback keeps its identity), else measured once
  // drawn, else `fallback` (the running mean, or the estimate before the
  // first measurement).
  const rowPx = useCallback(
    (rowId: string, fallback: number) =>
      heightOr(
        latest.current.rowHeight?.(rowId),
        heights.get(rowId) ?? fallback
      ),
    [heights, latest]
  );

  // The row heights of one group's list, by index, for row-window.ts.
  const heightAtOf = useCallback(
    (rowIds: readonly string[], fallback: number) => (index: number) =>
      rowPx(rowIds[index] ?? '', fallback),
    [rowPx]
  );

  // The px a whole group takes while none of its rows is drawn: the sum
  // of its rows' heights, each by rowPx.
  const groupPx = useCallback(
    (rowIds: readonly string[], fallback: number) =>
      sumHeights(heightAtOf(rowIds, fallback), 0, rowIds.length),
    [heightAtOf]
  );

  // Reads every rect it needs (the viewport, the header, each list and its
  // drawn rows), then sets each group's window; no DOM write in between,
  // so the browser lays out once.
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    const current = latest.current;
    if (!current.enabled || scroller === null) return;
    const view = viewportOf(scroller);
    const cover = headCover(headRef.current);
    for (const ul of lists.values()) {
      if (ul.hidden) continue;
      for (const li of Array.from(ul.children)) {
        const id = li.getAttribute('data-row-id');
        if (id === null) continue;
        const h = li.getBoundingClientRect().height;
        if (h <= 0) continue;
        const prev = heights.get(id);
        if (prev === undefined) {
          measured.sum += h;
          measured.n += 1;
        } else {
          measured.sum += h - prev;
        }
        heights.set(id, h);
      }
    }
    const fallback = estimate();
    const overscan = overscanRows * fallback;
    const bandTop = view.top + cover - overscan;
    const bandBottom = view.bottom + overscan;
    const pinnedIds = new Set(current.dragging);
    if (focusedRow.current !== null) pinnedIds.add(focusedRow.current);
    const next = new Map<string, RowSegment[]>();
    let changed = current.windows === null;
    for (const group of current.groups) {
      const ul = lists.get(group.id);
      if (ul === undefined) continue;
      const pinned: number[] = [];
      if (pinnedIds.size > 0) {
        group.rowIds.forEach((id, index) => {
          if (pinnedIds.has(id)) pinned.push(index);
        });
      }
      // An offscreen group meets no band (an empty one: no row's box can
      // reach it), so only its pinned rows are drawn.
      const offscreen = group.offscreen === true;
      const segments = windowSegments({
        count: group.rowIds.length,
        heightAt: heightAtOf(group.rowIds, fallback),
        listTop: ul.getBoundingClientRect().top,
        bandTop: offscreen ? Number.POSITIVE_INFINITY : bandTop,
        bandBottom: offscreen ? Number.NEGATIVE_INFINITY : bandBottom,
        pinned,
      });
      // An unchanged window keeps its array, so a host can memoize a
      // group's list on it and skip the groups a scroll did not move.
      const prev = current.windows?.get(group.id);
      if (prev !== undefined && sameSegments(prev, segments)) {
        next.set(group.id, prev);
      } else {
        changed = true;
        next.set(group.id, segments);
      }
    }
    if (
      changed ||
      current.windows === null ||
      next.size !== current.windows.size
    ) {
      setWindows(next);
    }
  }, [
    latest,
    headRef,
    lists,
    heights,
    measured,
    estimate,
    heightAtOf,
    overscanRows,
  ]);

  // Finds the scroller and listens to it while windowing is on, before the
  // first paint (a layout effect) so the first frame shows the right rows;
  // the passive effect after it asks a function prop again, since a host
  // ref it reads attaches after this effect ran. The effects, not the
  // render, touch the DOM, so the server render is clean.
  const unsubscribe = useRef<(() => void) | null>(null);
  const attach = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    const scroller = resolveScroller(root, scrollParent);
    const current = scrollerRef.current;
    if (current !== null && current.el === scroller.el) return;
    unsubscribe.current?.();
    scrollerRef.current = scroller;
    const onScroll = () => {
      if (latest.current.flushOnScroll) flushSync(measure);
      else measure();
    };
    const onResize = () => measure();
    const target: EventTarget = scroller.el ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    unsubscribe.current = () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      unsubscribe.current = null;
    };
    measure();
  }, [rootRef, scrollParent, measure, latest]);
  useClientLayoutEffect(() => {
    if (!enabled) {
      unsubscribe.current?.();
      scrollerRef.current = null;
      setWindows(null);
      return undefined;
    }
    attach();
    return () => {
      unsubscribe.current?.();
      scrollerRef.current = null;
    };
  }, [enabled, attach]);
  useEffect(() => {
    if (enabled) attach();
  }, [enabled, attach]);

  // The rows changed (a fold, a refresh, a re-sort that moves the focused
  // row), a drag started or the host's known heights changed (a new
  // rowHeight): the windows are measured again before paint. The key holds
  // every row id in order, since windows are by index: a re-sort that keeps
  // the counts still moves the pinned rows and, with known heights, the
  // gaps.
  const groupsKey = useMemo(
    () =>
      JSON.stringify(groups.map((g) => [g.id, g.offscreen === true, g.rowIds])),
    [groups]
  );
  // A row that left every group (a finished band, a deleted task, a folded
  // group's rows) drops its measured height, so neither the cache nor the
  // running mean keeps rows nobody draws; one that comes back is measured
  // again once drawn. Keyed on groupsKey, so a host that rebuilds `groups`
  // on every render with the same rows pays nothing.
  useClientLayoutEffect(() => {
    if (heights.size === 0) return;
    const shown = new Set<string>();
    for (const group of latest.current.groups) {
      for (const id of group.rowIds) shown.add(id);
    }
    for (const [id, h] of heights) {
      if (shown.has(id)) continue;
      heights.delete(id);
      measured.sum -= h;
      measured.n -= 1;
    }
    if (measured.n === 0) measured.sum = 0;
  }, [groupsKey, heights, measured, latest]);
  useClientLayoutEffect(() => {
    if (enabled) measure();
  }, [enabled, groupsKey, dragging, rowHeight, measure]);

  // The rows' layout changed as a whole (layoutKey): every measured height
  // is stale, so it is dropped with the running mean, and the drawn rows
  // are measured again before paint. The first value is the baseline, not
  // a change.
  const lastLayoutKey = useRef(layoutKey);
  useClientLayoutEffect(() => {
    if (lastLayoutKey.current === layoutKey) return;
    lastLayoutKey.current = layoutKey;
    heights.clear();
    measured.sum = 0;
    measured.n = 0;
    if (enabled) measure();
  }, [layoutKey, enabled, heights, measured, measure]);

  // A row asked for focus before it was mounted: focus it the moment it is.
  useClientLayoutEffect(() => {
    const id = pendingFocus.current;
    const root = rootRef.current;
    if (id === null || root === null) return;
    const li = root.querySelector<HTMLElement>(
      `[data-nav-item="row"][data-row-id="${CSS.escape(id)}"]`
    );
    if (li === null) return;
    pendingFocus.current = null;
    focusTargetOf(li)?.focus({ preventScroll: true });
  });

  // The windows read in render: the measured ones, else (the server and
  // the first client render) the first `initialRows` rows of the first
  // groups and a gap for the rest, sized by the known heights (rowHeight)
  // with the estimate for the others; a group that appears after the
  // first measurement draws as one gap (the same heights) for the one
  // commit before its own measurement. An offscreen group spends none of
  // the first rows: it is one gap of its full height from the start. Only
  // built while nothing is measured (a data change after that would
  // otherwise sum every row's height again for windows nobody reads).
  const unmeasured = windows === null;
  const initial = useMemo(() => {
    const map = new Map<string, RowSegment[]>();
    if (!unmeasured) return map;
    const counts = groups.map((g) =>
      g.offscreen === true ? 0 : g.rowIds.length
    );
    const budget = Number.isNaN(initialRows)
      ? 0
      : Math.max(0, Math.floor(initialRows));
    initialSegments(counts, budget, firstEstimate, (g, index) =>
      rowPx(groups[g]?.rowIds[index] ?? '', firstEstimate)
    ).forEach((segments, i) => {
      const group = groups[i];
      if (group === undefined) return;
      const count = group.rowIds.length;
      map.set(
        group.id,
        group.offscreen === true && count > 0
          ? [
              {
                kind: 'gap',
                start: 0,
                end: count,
                px: groupPx(group.rowIds, firstEstimate),
              },
            ]
          : segments
      );
    });
    return map;
  }, [unmeasured, groups, initialRows, firstEstimate, rowPx, groupPx]);

  const segmentsOf = useCallback(
    (groupId: string): RowSegment[] | null => {
      if (!enabled) return null;
      if (windows === null) return initial.get(groupId) ?? [];
      const known = windows.get(groupId);
      if (known !== undefined) return known;
      const group = groups.find((g) => g.id === groupId);
      const count = group?.rowIds.length ?? 0;
      return group === undefined || count === 0
        ? []
        : [
            {
              kind: 'gap',
              start: 0,
              end: count,
              px: groupPx(group.rowIds, estimate()),
            },
          ];
    },
    [enabled, windows, initial, groups, estimate, groupPx]
  );

  const registerList = useCallback(
    (groupId: string, el: HTMLUListElement | null) => {
      if (el === null) lists.delete(groupId);
      else lists.set(groupId, el);
    },
    [lists]
  );

  // Shows the band [top, bottom] (client coordinates) under the sticky
  // header. 'nearest' scrolls the least that shows it whole (a band taller
  // than the viewport aligns its top); 'start' always puts its top at the
  // top of the shown viewport, just under the header.
  const revealBand = useCallback(
    (top: number, bottom: number, align: 'nearest' | 'start' = 'nearest') => {
      const scroller = scrollerRef.current;
      if (scroller === null) return;
      const view = viewportOf(scroller);
      const shownTop = view.top + headCover(headRef.current);
      if (align === 'start' || top < shownTop) {
        scrollBy(scroller, top - shownTop);
      } else if (bottom > view.bottom) {
        scrollBy(scroller, Math.min(bottom - view.bottom, top - shownTop));
      }
    },
    [headRef]
  );

  const revealElement = useCallback(
    (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      revealBand(rect.top, rect.bottom);
    },
    [revealBand]
  );

  // Where an unmounted row sits: its list's top plus the rows before it
  // (each measured, known or estimated, as in measure()).
  const revealRow = useCallback(
    (
      groupId: string,
      index: number,
      align: 'nearest' | 'start' = 'nearest'
    ) => {
      const ul = lists.get(groupId);
      const group = latest.current.groups.find((g) => g.id === groupId);
      if (ul === undefined || group === undefined) return;
      const heightAt = heightAtOf(group.rowIds, estimate());
      const top =
        ul.getBoundingClientRect().top + sumHeights(heightAt, 0, index);
      revealBand(top, top + heightAt(index), align);
      measure();
    },
    [lists, latest, heightAtOf, estimate, revealBand, measure]
  );

  const focusUnmountedRow = useCallback(
    (groupId: string, index: number, rowId: string) => {
      pendingFocus.current = rowId;
      revealRow(groupId, index);
      // measure() may have mounted it synchronously (no state change when
      // the window was already right): focus now rather than wait.
      const root = rootRef.current;
      const li = root?.querySelector<HTMLElement>(
        `[data-nav-item="row"][data-row-id="${CSS.escape(rowId)}"]`
      );
      if (li !== null && li !== undefined) {
        pendingFocus.current = null;
        focusTargetOf(li)?.focus({ preventScroll: true });
      }
    },
    [revealRow, rootRef]
  );

  // Whether a row is drawn now: an item of one of the registered lists.
  const isDrawn = useCallback(
    (rowId: string) => {
      for (const ul of lists.values()) {
        for (const li of Array.from(ul.children)) {
          if (li.getAttribute('data-row-id') === rowId) return true;
        }
      }
      return false;
    },
    [lists]
  );

  // Pins the focused row. One the windows left out (a cursor moved into a
  // row far from the viewport) is mounted at once: the windows are
  // measured again with it pinned, rather than at the next scroll.
  const setFocusedRow = useCallback(
    (rowId: string | null) => {
      if (focusedRow.current === rowId) return;
      focusedRow.current = rowId;
      if (rowId !== null && !isDrawn(rowId)) measure();
    },
    [isDrawn, measure]
  );

  return useMemo(
    () => ({
      segmentsOf,
      registerList,
      revealElement,
      focusUnmountedRow,
      revealRow,
      setFocusedRow,
    }),
    [
      segmentsOf,
      registerList,
      revealElement,
      focusUnmountedRow,
      revealRow,
      setFocusedRow,
    ]
  );
}

/** The element a nav item hands focus to: a group's toggle button, or the
    row's primary link, button or (in touch Select mode) the checkbox in
    its title (rendered by the host <Link>, so it is found in the DOM
    rather than through a ref). */
export function focusTargetOf(item: Element): HTMLElement | null {
  return item.querySelector<HTMLElement>(
    '[data-nav-target] > a, [data-nav-target] > button, [data-nav-target] > label > input, button[data-nav-target]'
  );
}
