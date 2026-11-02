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
  /** Called with each render's windows, to compare their identity. */
  onWindows?: (segments: (RowSegment[] | null)[]) => void;
}

/** A host list: one <ul> per group, a row <li data-row-id> per drawn row
    and a gap <li data-row-gap data-px> per gap segment. */
function WindowHost({
  groups,
  dragging = new Set(),
  estimate,
  overscan,
  flushOnScroll,
  onWindows,
}: WindowHostProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const windows = useRowWindows({
    rootRef,
    headRef,
    enabled: true,
    scrollParent: 'window',
    groups,
    dragging,
    estimate,
    overscan,
    flushOnScroll,
  });
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
  return createElement('div', { ref: rootRef }, lists);
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
