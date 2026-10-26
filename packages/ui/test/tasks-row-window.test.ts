import { describe, expect, test } from 'bun:test';

import {
  initialSegments,
  mountedCount,
  type RowSegment,
  sameSegments,
  windowSegments,
} from '../src/index';

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
