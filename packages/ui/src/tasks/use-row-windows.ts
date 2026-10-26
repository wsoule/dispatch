'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLatest } from '../edit/save-state';
import {
  initialSegments,
  type RowSegment,
  sameSegments,
  windowSegments,
} from './row-window';
import type { TaskScrollParent } from './types';

// The DOM half of TaskGroupTable's row windowing. One measurement pass
// serves every group: on each scroll (and resize, fold, data change) it
// reads the scroll viewport, the sticky column header, each group's list
// position and the heights of the rows that are drawn, then asks
// row-window.ts which rows of each group to mount. Rows that have never
// been drawn take the running mean of the measured ones, so a gap's size
// settles as the list is scrolled.
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
/** Rows kept mounted past each edge of the viewport, in row heights. */
const OVERSCAN_ROWS = 8;
/** Rows the first render draws before the first measurement: the first
    groups in order, whole, until this many rows are drawn. */
const INITIAL_ROWS = 60;

/** One shown (unfolded) group: its id and its rows' ids, in order. */
export interface RowWindowGroup {
  id: string;
  rowIds: readonly string[];
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
  /** Scrolls an unmounted row into view without focusing it. */
  revealRow: (groupId: string, index: number) => void;
  /** The row that has keyboard focus (kept mounted while the list scrolls
      away from it, so focus never falls to the body). */
  setFocusedRow: (rowId: string | null) => void;
}

interface Options {
  rootRef: { readonly current: HTMLElement | null };
  headRef: { readonly current: HTMLElement | null };
  /** Off below the windowAbove threshold: every row is drawn. */
  enabled: boolean;
  scrollParent: TaskScrollParent | undefined;
  /** The shown groups in reading order. */
  groups: readonly RowWindowGroup[];
  /** Rows being dragged: kept mounted so the drag survives a scroll. */
  dragging: ReadonlySet<string>;
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
}: Options): RowWindows {
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
  const latest = useLatest({ groups, dragging, windows, enabled });

  const estimate = useCallback(
    () => (measured.n > 0 ? measured.sum / measured.n : DEFAULT_ROW_PX),
    [measured]
  );

  // The row heights of one group's list: measured, else the estimate.
  const heightAtOf = useCallback(
    (rowIds: readonly string[], fallback: number) => (index: number) =>
      heights.get(rowIds[index] ?? '') ?? fallback,
    [heights]
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
    const overscan = OVERSCAN_ROWS * fallback;
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
      const segments = windowSegments({
        count: group.rowIds.length,
        heightAt: heightAtOf(group.rowIds, fallback),
        listTop: ul.getBoundingClientRect().top,
        bandTop,
        bandBottom,
        pinned,
      });
      const prev = current.windows?.get(group.id);
      if (prev === undefined || !sameSegments(prev, segments)) changed = true;
      next.set(group.id, segments);
    }
    if (
      changed ||
      current.windows === null ||
      next.size !== current.windows.size
    ) {
      setWindows(next);
    }
  }, [latest, headRef, lists, heights, measured, estimate, heightAtOf]);

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
    const onScroll = () => measure();
    const target: EventTarget = scroller.el ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    unsubscribe.current = () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      unsubscribe.current = null;
    };
    measure();
  }, [rootRef, scrollParent, measure]);
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

  // The rows changed (a fold, a refresh) or a drag started: the windows are
  // measured again before paint.
  const groupsKey = useMemo(
    () => groups.map((g) => `${g.id}:${g.rowIds.length}`).join('\n'),
    [groups]
  );
  useClientLayoutEffect(() => {
    if (enabled) measure();
  }, [enabled, groupsKey, dragging, measure]);

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
  // the first client render) the first INITIAL_ROWS rows of the first
  // groups and an estimated gap for the rest; a group that appears after
  // the first measurement draws as one gap for the one commit before its
  // own measurement.
  const initial = useMemo(() => {
    const map = new Map<string, RowSegment[]>();
    const counts = groups.map((g) => g.rowIds.length);
    initialSegments(counts, INITIAL_ROWS, DEFAULT_ROW_PX).forEach(
      (segments, i) => {
        const group = groups[i];
        if (group !== undefined) map.set(group.id, segments);
      }
    );
    return map;
  }, [groups]);

  const segmentsOf = useCallback(
    (groupId: string): RowSegment[] | null => {
      if (!enabled) return null;
      if (windows === null) return initial.get(groupId) ?? [];
      const known = windows.get(groupId);
      if (known !== undefined) return known;
      const group = groups.find((g) => g.id === groupId);
      const count = group?.rowIds.length ?? 0;
      return count === 0
        ? []
        : [{ kind: 'gap', start: 0, end: count, px: count * estimate() }];
    },
    [enabled, windows, initial, groups, estimate]
  );

  const registerList = useCallback(
    (groupId: string, el: HTMLUListElement | null) => {
      if (el === null) lists.delete(groupId);
      else lists.set(groupId, el);
    },
    [lists]
  );

  // Scrolls the least that shows the band [top, bottom] (client
  // coordinates) whole, under the sticky header; a band taller than the
  // viewport aligns its top.
  const revealBand = useCallback(
    (top: number, bottom: number) => {
      const scroller = scrollerRef.current;
      if (scroller === null) return;
      const view = viewportOf(scroller);
      const shownTop = view.top + headCover(headRef.current);
      if (top < shownTop) scrollBy(scroller, top - shownTop);
      else if (bottom > view.bottom) {
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

  // Where an unmounted row sits: its list's top plus the rows before it.
  const revealRow = useCallback(
    (groupId: string, index: number) => {
      const ul = lists.get(groupId);
      const group = latest.current.groups.find((g) => g.id === groupId);
      if (ul === undefined || group === undefined) return;
      const heightAt = heightAtOf(group.rowIds, estimate());
      let top = ul.getBoundingClientRect().top;
      for (let i = 0; i < index; i++) top += heightAt(i);
      revealBand(top, top + heightAt(index));
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

  const setFocusedRow = useCallback((rowId: string | null) => {
    focusedRow.current = rowId;
  }, []);

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
