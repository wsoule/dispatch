import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, type ReactNode, useRef } from 'react';
import { renderToString } from 'react-dom/server';

import {
  initialSegments,
  mountedCount,
  parseCollapsed,
  readCollapsedRaw,
  type RowSegment,
  type RowWindowGroup,
  type RowWindows,
  sameSegments,
  serializeCollapsed,
  subscribeCollapsed,
  toggleCollapsed,
  useRowWindows,
  windowSegments,
  writeCollapsed,
} from '../src/index';

afterEach(cleanup);

// The pure arithmetic of TaskGroupTable's row windowing (row-window.ts):
// which rows of a group meet the viewport band, which gaps stand for the
// rest, and the first render's budget before anything is measured.

const ROW = 55;
const uniform = () => ROW;

function px(segments: readonly RowSegment[]): number {
  return segments.reduce(
    (sum, s) => sum + (s.kind === 'gap' ? s.px : (s.end - s.start) * ROW),
    0
  );
}

describe('windowSegments', () => {
  test('rows meeting the band are mounted; the rest are gaps of their height', () => {
    // The list starts 200px above the band; the band is 600px tall.
    const segments = windowSegments({
      count: 100,
      heightAt: uniform,
      listTop: -200,
      bandTop: 0,
      bandBottom: 600,
      pinned: [],
    });
    // Rows 0–2 end above 0 (3 × 55 = 165 < 200); row 3 spans 165–220.
    // Row 14 starts at 570 (< 600), row 15 at 625.
    expect(segments).toEqual([
      { kind: 'gap', start: 0, end: 3, px: 3 * ROW },
      { kind: 'rows', start: 3, end: 15 },
      { kind: 'gap', start: 15, end: 100, px: 85 * ROW },
    ]);
    expect(px(segments)).toBe(100 * ROW);
    expect(mountedCount(segments)).toBe(12);
  });

  test('a list wholly above or below the band is one gap', () => {
    const above = windowSegments({
      count: 10,
      heightAt: uniform,
      listTop: -2000,
      bandTop: 0,
      bandBottom: 600,
      pinned: [],
    });
    expect(above).toEqual([{ kind: 'gap', start: 0, end: 10, px: 10 * ROW }]);
    const below = windowSegments({
      count: 10,
      heightAt: uniform,
      listTop: 900,
      bandTop: 0,
      bandBottom: 600,
      pinned: [],
    });
    expect(below).toEqual([{ kind: 'gap', start: 0, end: 10, px: 10 * ROW }]);
    expect(
      windowSegments({
        count: 0,
        heightAt: uniform,
        listTop: 0,
        bandTop: 0,
        bandBottom: 600,
        pinned: [],
      })
    ).toEqual([]);
  });

  test('pinned rows stay mounted outside the band, splitting the gaps', () => {
    const segments = windowSegments({
      count: 100,
      heightAt: uniform,
      listTop: -3000,
      bandTop: 0,
      bandBottom: 600,
      pinned: [2, 3, 90, 200, -1],
    });
    // 3000 / 55 → rows 0–53 end above 0; row 54 spans 2970–3025.
    // Row 65 starts at 3575 (< 3600), row 66 at 3630.
    expect(segments).toEqual([
      { kind: 'gap', start: 0, end: 2, px: 2 * ROW },
      { kind: 'rows', start: 2, end: 4 },
      { kind: 'gap', start: 4, end: 54, px: 50 * ROW },
      { kind: 'rows', start: 54, end: 66 },
      { kind: 'gap', start: 66, end: 90, px: 24 * ROW },
      { kind: 'rows', start: 90, end: 91 },
      { kind: 'gap', start: 91, end: 100, px: 9 * ROW },
    ]);
    expect(px(segments)).toBe(100 * ROW);
  });

  test('measured heights place the rows and size the gaps', () => {
    // Row 1 is a tall card.
    const heightAt = (i: number) => (i === 1 ? 300 : ROW);
    const segments = windowSegments({
      count: 5,
      heightAt,
      listTop: -350,
      bandTop: 0,
      bandBottom: 100,
      pinned: [],
    });
    // Row 0: -350…-295, row 1: -295…5 (meets the band), row 2: 5…60,
    // row 3: 60…115, row 4: 115… (starts past 100).
    expect(segments).toEqual([
      { kind: 'gap', start: 0, end: 1, px: ROW },
      { kind: 'rows', start: 1, end: 4 },
      { kind: 'gap', start: 4, end: 5, px: ROW },
    ]);
  });
});

describe('sameSegments', () => {
  test('compares kind, range and gap size', () => {
    const a: RowSegment[] = [
      { kind: 'gap', start: 0, end: 3, px: 165 },
      { kind: 'rows', start: 3, end: 15 },
    ];
    expect(sameSegments(a, a)).toBe(true);
    expect(
      sameSegments(a, [
        { kind: 'gap', start: 0, end: 3, px: 165 },
        { kind: 'rows', start: 3, end: 15 },
      ])
    ).toBe(true);
    expect(
      sameSegments(a, [
        { kind: 'gap', start: 0, end: 3, px: 166 },
        { kind: 'rows', start: 3, end: 15 },
      ])
    ).toBe(false);
    expect(
      sameSegments(a, [
        { kind: 'gap', start: 0, end: 3, px: 165 },
        { kind: 'rows', start: 3, end: 16 },
      ])
    ).toBe(false);
    expect(sameSegments(a, a.slice(0, 1))).toBe(false);
  });
});

describe('initialSegments', () => {
  test('draws whole groups in order up to the budget, then estimated gaps', () => {
    expect(initialSegments([40, 30, 0, 200], 60, ROW)).toEqual([
      [{ kind: 'rows', start: 0, end: 40 }],
      [
        { kind: 'rows', start: 0, end: 20 },
        { kind: 'gap', start: 20, end: 30, px: 10 * ROW },
      ],
      [],
      [{ kind: 'gap', start: 0, end: 200, px: 200 * ROW }],
    ]);
  });

  test('a gap is the sum of the known heights, the estimate for the rest', () => {
    // Group 0's rows are 100, 200, 300…; group 2 knows only its row 1.
    const known = (group: number, index: number): number | undefined => {
      if (group === 0) return (index + 1) * 100;
      if (group === 2 && index === 1) return 500;
      return undefined;
    };
    expect(initialSegments([4, 0, 3], 1, ROW, known)).toEqual([
      [
        { kind: 'rows', start: 0, end: 1 },
        { kind: 'gap', start: 1, end: 4, px: 200 + 300 + 400 },
      ],
      [],
      [{ kind: 'gap', start: 0, end: 3, px: ROW + 500 + ROW }],
    ]);
  });

  test('a known height of 0, below 0 or NaN takes the estimate', () => {
    const bad = [0, -40, Number.NaN];
    expect(initialSegments([3], 0, ROW, (_group, index) => bad[index])).toEqual(
      [[{ kind: 'gap', start: 0, end: 3, px: 3 * ROW }]]
    );
  });
});

// useRowWindows for a host's own grouped lists (L26: the board's columns).
// happy-dom has no layout, so every rect is 0: no row is ever measured,
// every list starts at the viewport's top and the window is the viewport
// (the document scrolls). The host below draws each group's window as
// rows and gap items, the way a board column does.

interface WindowHostProps {
  groups: readonly RowWindowGroup[];
  dragging?: ReadonlySet<string>;
  estimate?: number;
  overscan?: number;
  flushOnScroll?: boolean;
  rowHeight?: (rowId: string) => number | undefined;
  initialRows?: number;
  /** The scroll container; the document (window) when absent. */
  scrollParent?: HTMLElement;
  /** Draws a sticky header (data-head) above the lists, on headRef. */
  head?: boolean;
  /** Receives the hook's handle on each render, for revealRow. */
  handle?: { current: RowWindows | null };
  /** Called with each render's windows, to compare their identity. */
  onWindows?: (segments: (RowSegment[] | null)[]) => void;
}

/** No row being dragged: one set for every render, so a re-render alone
    (a new `dragging`) never measures again. */
const NO_DRAG: ReadonlySet<string> = new Set();

/** A host list: one <ul> per group, a row <li data-row-id> per drawn row
    and a gap <li data-row-gap data-px> per gap segment. */
function WindowHost({
  groups,
  dragging = NO_DRAG,
  estimate,
  overscan,
  flushOnScroll,
  rowHeight,
  initialRows,
  scrollParent,
  head = false,
  handle,
  onWindows,
}: WindowHostProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const windows = useRowWindows({
    rootRef,
    headRef,
    enabled: true,
    scrollParent: scrollParent ?? 'window',
    groups,
    dragging,
    estimate,
    overscan,
    flushOnScroll,
    rowHeight,
    initialRows,
  });
  if (handle !== undefined) handle.current = windows;
  onWindows?.(groups.map((group) => windows.segmentsOf(group.id)));
  const lists: ReactNode[] = groups.map((group) => {
    const segments = windows.segmentsOf(group.id) ?? [
      { kind: 'rows', start: 0, end: group.rowIds.length },
    ];
    const items: ReactNode[] = [];
    for (const segment of segments) {
      if (segment.kind === 'gap') {
        items.push(
          createElement('li', {
            key: `gap-${segment.start}`,
            'data-row-gap': segment.end - segment.start,
            'data-px': segment.px,
          })
        );
        continue;
      }
      for (let i = segment.start; i < segment.end; i++) {
        const id = group.rowIds[i] ?? '';
        items.push(createElement('li', { key: id, 'data-row-id': id }, id));
      }
    }
    return createElement(
      'ul',
      {
        key: group.id,
        'data-group': group.id,
        ref: (el: HTMLUListElement | null) =>
          windows.registerList(group.id, el),
      },
      items
    );
  });
  return createElement(
    'div',
    { ref: rootRef },
    head
      ? createElement('div', {
          ref: headRef,
          'data-head': '',
          style: { position: 'sticky', top: '8px' },
        })
      : null,
    lists
  );
}

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** A group's drawn window read back from the DOM: row ids and gaps. */
function drawn(group: string): (string | { gap: number; px: number })[] {
  const ul = document.querySelector(`[data-group="${group}"]`);
  return Array.from(ul?.children ?? []).map((li) => {
    const id = li.getAttribute('data-row-id');
    if (id !== null) return id;
    return {
      gap: Number(li.getAttribute('data-row-gap')),
      px: Number(li.getAttribute('data-px')),
    };
  });
}

describe('useRowWindows for a host', () => {
  test('an offscreen group mounts only its pinned rows, one gap of its height otherwise', () => {
    const groups: RowWindowGroup[] = [
      { id: 'a', rowIds: ids('a', 30) },
      { id: 'b', rowIds: ids('b', 30), offscreen: true },
      { id: 'c', rowIds: ids('c', 30), offscreen: true },
    ];
    render(createElement(WindowHost, { groups, dragging: new Set(['b-7']) }));
    // The on-screen group draws the rows in the viewport and its overscan.
    expect(drawn('a')[0]).toBe('a-0');
    // b: nothing but the row being dragged, with gaps around it.
    expect(drawn('b')).toEqual([
      { gap: 7, px: 7 * 55 },
      'b-7',
      { gap: 22, px: 22 * 55 },
    ]);
    // c: nothing pinned, one gap.
    expect(drawn('c')).toEqual([{ gap: 30, px: 30 * 55 }]);
  });

  test('a group that scrolls back on screen draws its rows again', () => {
    const offscreen: RowWindowGroup[] = [
      { id: 'b', rowIds: ids('b', 10), offscreen: true },
    ];
    const view = render(createElement(WindowHost, { groups: offscreen }));
    expect(drawn('b')).toEqual([{ gap: 10, px: 10 * 55 }]);
    view.rerender(
      createElement(WindowHost, { groups: [{ id: 'b', rowIds: ids('b', 10) }] })
    );
    expect(drawn('b')).toEqual(ids('b', 10));
  });

  test('estimate sizes the rows before the first measurement', () => {
    const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 100) }];
    render(createElement(WindowHost, { groups, estimate: 120 }));
    // Nothing is measured (no layout), so every undrawn row is 120px and
    // the band's overscan is eight of them.
    const bandBottom = window.innerHeight + 8 * 120;
    const shown = Math.ceil(bandBottom / 120);
    expect(drawn('a')).toEqual([
      ...ids('a', shown),
      { gap: 100 - shown, px: (100 - shown) * 120 },
    ]);
  });

  test('overscan sets how many rows past the viewport stay mounted', () => {
    const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 100) }];
    render(createElement(WindowHost, { groups, estimate: 120, overscan: 3 }));
    // Three 120px rows of overscan below the viewport instead of eight.
    const shown = Math.ceil((window.innerHeight + 3 * 120) / 120);
    expect(drawn('a')).toEqual([
      ...ids('a', shown),
      { gap: 100 - shown, px: (100 - shown) * 120 },
    ]);
  });

  // The lists' tops move with a stubbed scroll offset (happy-dom has no
  // layout), so a scroll event changes which rows meet the band.
  function stubListTops(): {
    scrollBy: (px: number) => void;
    restore: () => void;
  } {
    let offset = 0;
    const original = HTMLUListElement.prototype.getBoundingClientRect;
    HTMLUListElement.prototype.getBoundingClientRect = function () {
      return {
        top: -offset,
        bottom: -offset,
        height: 0,
        width: 0,
        left: 0,
        right: 0,
        x: 0,
        y: -offset,
        toJSON: () => ({}),
      } as DOMRect;
    };
    return {
      scrollBy: (px) => {
        offset += px;
      },
      restore: () => {
        HTMLUListElement.prototype.getBoundingClientRect = original;
      },
    };
  }

  test('flushOnScroll renders the new windows inside the scroll event', () => {
    const lists = stubListTops();
    try {
      const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 200) }];
      render(createElement(WindowHost, { groups, flushOnScroll: true }));
      expect(drawn('a')[0]).toBe('a-0');
      let atEvent: unknown = null;
      // act holds back a render left for later until it returns.
      act(() => {
        lists.scrollBy(100 * 55);
        fireEvent.scroll(window);
        atEvent = drawn('a')[1];
      });
      expect(atEvent).not.toBe('a-1');
      expect(drawn('a')).toContain('a-100');
    } finally {
      lists.restore();
    }
  });

  test('without flushOnScroll a scroll renders after its event', () => {
    const lists = stubListTops();
    try {
      const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 200) }];
      render(createElement(WindowHost, { groups }));
      let atEvent: unknown = null;
      act(() => {
        lists.scrollBy(100 * 55);
        fireEvent.scroll(window);
        atEvent = drawn('a')[1];
      });
      expect(atEvent).toBe('a-1');
      expect(drawn('a')).toContain('a-100');
    } finally {
      lists.restore();
    }
  });

  test('a scroll keeps the window array of a group it did not move', () => {
    const lists = stubListTops();
    try {
      const groups: RowWindowGroup[] = [
        { id: 'a', rowIds: ids('a', 200) },
        { id: 'b', rowIds: ids('b', 5), offscreen: true },
      ];
      const seen: (RowSegment[] | null)[][] = [];
      render(
        createElement(WindowHost, {
          groups,
          flushOnScroll: true,
          onWindows: (windows) => seen.push(windows),
        })
      );
      const before = seen.at(-1);
      act(() => {
        lists.scrollBy(100 * 55);
        fireEvent.scroll(window);
      });
      const after = seen.at(-1);
      // a moved, so its window is a new array; b (offscreen) did not.
      expect(after?.[0]).not.toBe(before?.[0]);
      expect(after?.[1]).toBe(before?.[1]);
    } finally {
      lists.restore();
    }
  });

  test('the first render draws the first rows and estimated gaps; an offscreen group spends none', () => {
    const html = renderToString(
      createElement(WindowHost, {
        groups: [
          { id: 'side', rowIds: ids('side', 50), offscreen: true },
          { id: 'a', rowIds: ids('a', 100) },
        ],
        estimate: 120,
      })
    );
    expect(html).toContain('data-row-gap="50" data-px="6000"');
    expect(html).not.toContain('side-0<');
    // The 60 first rows all go to the on-screen group.
    expect(html).toContain('>a-59<');
    expect(html).not.toContain('>a-60<');
    expect(html).toContain('data-row-gap="40" data-px="4800"');
  });

  // Known heights (rowHeight), as Live's bands give them: every row here is
  // taller than happy-dom's viewport, so with no overscan the band meets
  // only the list's first row.
  const tall = (id: string) => 5000 + Number(id.split('-')[1]) * 100;

  test('rowHeight sizes the gaps before any row is measured', () => {
    expect(window.innerHeight).toBeLessThan(5000);
    const groups: RowWindowGroup[] = [
      { id: 'a', rowIds: ids('a', 6) },
      { id: 'b', rowIds: ids('b', 3), offscreen: true },
    ];
    render(createElement(WindowHost, { groups, rowHeight: tall, overscan: 0 }));
    // Nothing is measured (no layout): a-0 (0…5000) is the only row in the
    // viewport, and each gap is the sum of its rows' known heights.
    expect(drawn('a')).toEqual([
      'a-0',
      { gap: 5, px: 5100 + 5200 + 5300 + 5400 + 5500 },
    ]);
    expect(drawn('b')).toEqual([{ gap: 3, px: 5000 + 5100 + 5200 }]);
  });

  test('a group that appears after the first measurement is a gap of its known heights', () => {
    const a: RowWindowGroup = { id: 'a', rowIds: ids('a', 2) };
    const seen: (RowSegment[] | null)[][] = [];
    const host = (groups: RowWindowGroup[]) =>
      createElement(WindowHost, {
        groups,
        rowHeight: tall,
        overscan: 0,
        onWindows: (windows) => seen.push(windows),
      });
    const view = render(host([a]));
    seen.length = 0;
    view.rerender(host([a, { id: 'c', rowIds: ids('c', 2) }]));
    // The commit before c's own measurement draws it as one gap.
    expect(seen[0]?.[1]).toEqual([
      { kind: 'gap', start: 0, end: 2, px: 5000 + 5100 },
    ]);
    // Measured before paint: c's first row is drawn.
    expect(drawn('c')).toEqual(['c-0', { gap: 1, px: 5100 }]);
  });

  // Every drawn row measures `px(id)` (100 unless given), so a test can
  // tell a measured height from a known one. Restored by the returned
  // function.
  function stubRowHeights(px: (id: string) => number = () => 100): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id =
        this.tagName === 'LI' ? this.getAttribute('data-row-id') : null;
      if (id !== null) {
        const h = px(id);
        return {
          top: 0,
          bottom: h,
          height: h,
          width: 0,
          left: 0,
          right: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  test('rowHeight wins over a measurement, and only measured heights make the mean', () => {
    // Every drawn row measures 100px; rowHeight says 5000 for all but the
    // last row, which it does not know.
    const restoreRows = stubRowHeights();
    const lists = stubListTops();
    try {
      const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 10) }];
      render(
        createElement(WindowHost, {
          groups,
          rowHeight: (id) => (id === 'a-9' ? undefined : 5000),
          initialRows: 1,
          overscan: 0,
        })
      );
      // a-0 measured 100, but its known 5000 places a-1 below the
      // viewport. The unknown a-9 takes the mean of the measured rows
      // (100), never a known height.
      expect(drawn('a')).toEqual(['a-0', { gap: 9, px: 8 * 5000 + 100 }]);
      act(() => {
        lists.scrollBy(5150);
        fireEvent.scroll(window);
      });
      // a-0 scrolled above the viewport stands as its known 5000, not its
      // measured 100.
      expect(drawn('a')).toEqual([
        { gap: 1, px: 5000 },
        'a-1',
        { gap: 8, px: 7 * 5000 + 100 },
      ]);
    } finally {
      lists.restore();
      restoreRows();
    }
  });

  test('a new rowHeight re-windows before paint: a row that grew moves the gaps', () => {
    const groups: RowWindowGroup[] = [{ id: 'a', rowIds: ids('a', 4) }];
    const host = (rowHeight: (id: string) => number) =>
      createElement(WindowHost, { groups, rowHeight, overscan: 0 });
    const view = render(host(() => 5000));
    expect(drawn('a')).toEqual(['a-0', { gap: 3, px: 3 * 5000 }]);
    // a-2 grows while it is away from the viewport; no scroll follows.
    view.rerender(host((id) => (id === 'a-2' ? 7000 : 5000)));
    expect(drawn('a')).toEqual(['a-0', { gap: 3, px: 2 * 5000 + 7000 }]);
  });

  test('setFocusedRow mounts a row the window left out, at once', () => {
    const handle: { current: RowWindows | null } = { current: null };
    render(
      createElement(WindowHost, {
        groups: [{ id: 'a', rowIds: ids('a', 10) }],
        rowHeight: () => 5000,
        overscan: 0,
        handle,
      })
    );
    expect(drawn('a')).toEqual(['a-0', { gap: 9, px: 9 * 5000 }]);
    act(() => handle.current?.setFocusedRow('a-7'));
    expect(drawn('a')).toEqual([
      'a-0',
      { gap: 6, px: 6 * 5000 },
      'a-7',
      { gap: 2, px: 2 * 5000 },
    ]);
  });

  test('a re-sort that moves the focused row away keeps it mounted', () => {
    const handle: { current: RowWindows | null } = { current: null };
    const host = (rowIds: string[]) =>
      createElement(WindowHost, {
        groups: [{ id: 'a', rowIds }],
        rowHeight: () => 5000,
        overscan: 0,
        handle,
      });
    const view = render(host(ids('a', 10)));
    act(() => handle.current?.setFocusedRow('a-0'));
    // a-0 moves to the end: same count, new order.
    view.rerender(host([...ids('a', 10).slice(1), 'a-0']));
    expect(drawn('a')).toEqual(['a-1', { gap: 8, px: 8 * 5000 }, 'a-0']);
  });

  test('rows that leave every group leave the running mean', () => {
    // x rows measure 100px, y rows 50px; nothing has a known height.
    const restoreRows = stubRowHeights((id) => (id.startsWith('x') ? 100 : 50));
    try {
      const host = (rowIds: string[]) =>
        createElement(WindowHost, {
          groups: [{ id: 'a', rowIds }],
          overscan: 0,
        });
      const view = render(host(ids('x', 3)));
      expect(drawn('a')).toEqual(ids('x', 3));
      // The x rows go; 40 y rows come. The y rows drawn are measured at 50,
      // and the rest stand at the mean: 50, with the x rows' 100s gone.
      view.rerender(host(ids('y', 40)));
      const tail = drawn('a').at(-1);
      if (tail === undefined || typeof tail === 'string') {
        throw new Error('expected a trailing gap');
      }
      expect(tail.px / tail.gap).toBe(50);
    } finally {
      restoreRows();
    }
  });

  test('initialRows sets how many rows the first render draws', () => {
    const html = renderToString(
      createElement(WindowHost, {
        groups: [
          { id: 'side', rowIds: ids('side', 2), offscreen: true },
          { id: 'a', rowIds: ids('a', 10) },
          { id: 'b', rowIds: ids('b', 5) },
        ],
        estimate: 120,
        initialRows: 4,
        rowHeight: (id) =>
          id.startsWith('b') ? 1000 : id.startsWith('side') ? 700 : undefined,
      })
    );
    expect(html).toContain('>a-3<');
    expect(html).not.toContain('>a-4<');
    // a's tail has no known heights: the estimate per row.
    expect(html).toContain('data-row-gap="6" data-px="720"');
    // b and the offscreen group: the sums of their known heights.
    expect(html).toContain('data-row-gap="5" data-px="5000"');
    expect(html).toContain('data-row-gap="2" data-px="1400"');
    expect(html).not.toContain('>b-0<');
  });

  // revealRow in an element scroller: a 600px viewport, a sticky header
  // stuck 8px down and 32px tall (so rows under its first 40px are
  // covered), and 200px rows (rowHeight) below it from the content's 40px.
  function revealSetup(): {
    scroller: HTMLElement;
    handle: { current: RowWindows | null };
    restore: () => void;
  } {
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    const original = HTMLUListElement.prototype.getBoundingClientRect;
    HTMLUListElement.prototype.getBoundingClientRect = function () {
      const top = 40 - scroller.scrollTop;
      return { top, bottom: top + 20 * 200, height: 20 * 200 } as DOMRect;
    };
    const handle: { current: RowWindows | null } = { current: null };
    render(
      createElement(WindowHost, {
        groups: [{ id: 'a', rowIds: ids('a', 20) }],
        rowHeight: () => 200,
        scrollParent: scroller,
        head: true,
        handle,
        overscan: 0,
      }),
      { container: scroller }
    );
    const head = scroller.querySelector<HTMLElement>('[data-head]');
    if (head === null) throw new Error('no head');
    head.getBoundingClientRect = () =>
      ({ top: 8, bottom: 40, height: 32 }) as DOMRect;
    return {
      scroller,
      handle,
      restore: () => {
        HTMLUListElement.prototype.getBoundingClientRect = original;
        scroller.remove();
      },
    };
  }

  test("revealRow 'start' puts the row's top just under the sticky header", () => {
    const { scroller, handle, restore } = revealSetup();
    try {
      // a-5 starts at 40 + 5 × 200 = 1040 in the content; under the
      // header's 40px cover means scrollTop 1000.
      act(() => handle.current?.revealRow('a', 5, 'start'));
      expect(scroller.scrollTop).toBe(1040 - 40);
      // A row already in view still moves to the top.
      act(() => handle.current?.revealRow('a', 6, 'start'));
      expect(scroller.scrollTop).toBe(1240 - 40);
      // The rows there are mounted.
      expect(drawn('a')).toContain('a-6');
    } finally {
      restore();
    }
  });

  test("revealRow's default ('nearest') scrolls the least", () => {
    const { scroller, handle, restore } = revealSetup();
    try {
      act(() => {
        scroller.scrollTop = 1000;
      });
      // a-6 (240…440 in the viewport) is whole in view: no scroll.
      act(() => handle.current?.revealRow('a', 6));
      expect(scroller.scrollTop).toBe(1000);
      // a-12 (1440…1640) is below: its bottom comes to the viewport's.
      act(() => handle.current?.revealRow('a', 12, 'nearest'));
      expect(scroller.scrollTop).toBe(1000 + (1640 - 600));
      // a-2 (440 in the content, −1600 in the viewport) is above: its
      // top comes to just under the header.
      act(() => handle.current?.revealRow('a', 2));
      expect(scroller.scrollTop).toBe(440 - 40);
    } finally {
      restore();
    }
  });
});

describe('the windowing and fold helpers are exported', () => {
  test('as functions from the package root', () => {
    for (const fn of [
      useRowWindows,
      readCollapsedRaw,
      writeCollapsed,
      subscribeCollapsed,
      parseCollapsed,
      serializeCollapsed,
      toggleCollapsed,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  test('a fold written in this page reaches a subscriber and reads back', () => {
    let calls = 0;
    const stop = subscribeCollapsed(() => {
      calls += 1;
    });
    try {
      writeCollapsed('test:folds', 'session', new Set(['b', 'a']));
      expect(calls).toBe(1);
      expect(readCollapsedRaw('test:folds', 'session')).toBe('["a","b"]');
      expect(readCollapsedRaw('test:folds', 'local')).toBeNull();
    } finally {
      stop();
      window.sessionStorage.removeItem('test:folds');
    }
  });
});
