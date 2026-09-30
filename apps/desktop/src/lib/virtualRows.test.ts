import { Virtualizer } from '@tanstack/react-virtual';
import { describe, expect, test } from 'bun:test';

import {
  flattenGroups,
  headerRowKey,
  indexByKey,
  nearColumnIndexes,
  pinnedRangeExtractor,
  sameColumnIndexes,
  stepKey,
  trackNearViewport,
  UNMEASURED_VIEWPORT,
  viewportOrFallback,
} from './virtualRows';

interface Item {
  id: string;
}

const items = (prefix: string, n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe('flattenGroups', () => {
  test('puts each header before its items', () => {
    const rows = flattenGroups(
      [
        { key: 'a', header: 'A', items: items('a', 2) },
        { key: 'b', header: 'B', items: items('b', 1) },
      ],
      new Set(),
      (item) => item.id
    );
    expect(rows.map((r) => r.key)).toEqual([
      headerRowKey('a'),
      'a0',
      'a1',
      headerRowKey('b'),
      'b0',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'header', collapsed: false });
    expect(rows[1]).toMatchObject({ kind: 'item', groupKey: 'a' });
  });

  test('a collapsed group keeps only its header', () => {
    const rows = flattenGroups(
      [
        { key: 'a', header: 'A', items: items('a', 3) },
        { key: 'b', header: 'B', items: items('b', 1) },
      ],
      new Set(['a']),
      (item) => item.id
    );
    expect(rows.map((r) => r.key)).toEqual([
      headerRowKey('a'),
      headerRowKey('b'),
      'b0',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'header', collapsed: true });
  });

  test('a headerless group is a bare run of items, never collapsed away', () => {
    const rows = flattenGroups(
      [{ key: 'all', header: null, items: items('t', 2) }],
      new Set(['all']),
      (item) => item.id
    );
    expect(rows.map((r) => r.key)).toEqual(['t0', 't1']);
  });
});

test('indexByKey maps every key to its row index', () => {
  const map = indexByKey(items('t', 3), (item) => item.id);
  expect([...map]).toEqual([
    ['t0', 0],
    ['t1', 1],
    ['t2', 2],
  ]);
});

describe('pinnedRangeExtractor', () => {
  const range = { startIndex: 10, endIndex: 12, overscan: 1, count: 100 };

  test('without pins it is the default window', () => {
    expect(pinnedRangeExtractor([])(range)).toEqual([9, 10, 11, 12, 13]);
  });

  test('adds pins outside the window, sorted and deduplicated', () => {
    expect(pinnedRangeExtractor([80, 2, 11, 80])(range)).toEqual([
      2, 9, 10, 11, 12, 13, 80,
    ]);
  });

  test('drops pins past the end of the list', () => {
    expect(pinnedRangeExtractor([-1, 100, 250])(range)).toEqual([
      9, 10, 11, 12, 13,
    ]);
  });
});

test('an unmeasured viewport windows as a typical screen', () => {
  expect(viewportOrFallback({ width: 0, height: 0 })).toBe(UNMEASURED_VIEWPORT);
  expect(viewportOrFallback({ width: 400, height: 300 })).toEqual({
    width: 400,
    height: 300,
  });
});

describe('trackNearViewport', () => {
  // A 900px viewport scrolled to 5000.
  test('a track overlapping the window is near', () => {
    expect(trackNearViewport(4800, 1000, 5000, 900)).toBe(true);
  });
  test('a track within a viewport above or below is near', () => {
    expect(trackNearViewport(3500, 700, 5000, 900)).toBe(true);
    expect(trackNearViewport(6600, 500, 5000, 900)).toBe(true);
  });
  test('a track far above or below is not', () => {
    expect(trackNearViewport(0, 1000, 5000, 900)).toBe(false);
    expect(trackNearViewport(9000, 1000, 5000, 900)).toBe(false);
  });
});

describe('nearColumnIndexes', () => {
  // Seven 340px columns 8px apart on a 1154px-wide board (a 1440px window).
  const spans = Array.from(
    { length: 7 },
    (_, i) => [i * 348, i * 348 + 340] as const
  );
  const near = (scrollLeft: number, margin: number) => [
    ...(nearColumnIndexes(spans, scrollLeft, 1154, margin) ?? []),
  ];
  test('columns reaching within half a width of the window are near', () => {
    expect(near(0, 0.5)).toEqual([0, 1, 2, 3, 4]);
    expect(near(1100, 0.5)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  test('without a margin, only the visible ones', () => {
    expect(near(0, 0)).toEqual([0, 1, 2, 3]);
  });
  test('nothing to measure keeps every column near', () => {
    expect(nearColumnIndexes(spans, 0, 0, 0.5)).toBeNull();
    expect(nearColumnIndexes([], 0, 1154, 0.5)).toBeNull();
  });
  test('sameColumnIndexes compares by members', () => {
    expect(sameColumnIndexes(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameColumnIndexes(new Set([1, 2]), new Set([1]))).toBe(false);
    expect(sameColumnIndexes(null, null)).toBe(true);
    expect(sameColumnIndexes(null, new Set())).toBe(false);
  });
});

describe('stepKey (keyboard → row)', () => {
  const keys = ['a', 'b', 'c'];
  test('moves by delta and clamps at both ends', () => {
    expect(stepKey(keys, 'a', 1)).toBe('b');
    expect(stepKey(keys, 'c', 1)).toBe('c');
    expect(stepKey(keys, 'a', -1)).toBe('a');
  });
  test('lands on the first row from nothing, or from a key that left', () => {
    expect(stepKey(keys, null, 1)).toBe('a');
    expect(stepKey(keys, 'gone', -1)).toBe('a');
  });
  test('is null for an empty list', () => {
    expect(stepKey([], null, 1)).toBeNull();
  });
});

// The real windowing engine with a fake viewport — no DOM, no layout. Proves a 2000-row
// list mounts a screenful, follows the scroll offset, and keeps pinned rows.
function windowFor(opts: {
  count: number;
  viewport: { width: number; height: number };
  scrollTop: number;
  pinned?: number[];
}): number[] {
  const virtualizer = new Virtualizer<Element, Element>({
    count: opts.count,
    estimateSize: () => 36,
    overscan: 8,
    getScrollElement: () => ({}) as Element,
    scrollToFn: () => {},
    rangeExtractor: pinnedRangeExtractor(opts.pinned ?? []),
    observeElementRect: (_instance, cb) => {
      cb(viewportOrFallback(opts.viewport));
    },
    observeElementOffset: (_instance, cb) => {
      cb(opts.scrollTop, false);
    },
  });
  virtualizer._willUpdate();
  return virtualizer.getVirtualItems().map((item) => item.index);
}

describe('windowing 2000 rows', () => {
  test('mounts one viewport plus overscan', () => {
    const indexes = windowFor({
      count: 2000,
      viewport: { width: 800, height: 720 },
      scrollTop: 0,
    });
    // 720 / 36 = 20 visible, + 8 overscan below.
    expect(indexes.length).toBeLessThanOrEqual(30);
    expect(indexes[0]).toBe(0);
  });

  test('follows the scroll offset', () => {
    const indexes = windowFor({
      count: 2000,
      viewport: { width: 800, height: 720 },
      scrollTop: 36 * 1000,
    });
    expect(indexes[0]).toBe(992);
    expect(indexes).toContain(1019);
    expect(indexes.length).toBeLessThanOrEqual(40);
  });

  test('keeps a pinned row mounted far from the window', () => {
    const indexes = windowFor({
      count: 2000,
      viewport: { width: 800, height: 720 },
      scrollTop: 0,
      pinned: [1500],
    });
    expect(indexes).toContain(1500);
    expect(indexes.length).toBeLessThanOrEqual(31);
  });

  test('an unmeasured viewport still mounts a bounded screenful', () => {
    const indexes = windowFor({
      count: 2000,
      viewport: { width: 0, height: 0 },
      scrollTop: 0,
    });
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.length).toBeLessThanOrEqual(40);
  });
});
