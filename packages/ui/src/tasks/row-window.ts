// The pure half of TaskGroupTable's row windowing (use-row-windows.ts is the
// DOM half): given a group's row heights, where its list sits in the scroll
// viewport and which rows must stay mounted whatever the scroll, decide
// which rows are drawn and how much empty space stands in for the rest.
// No React and no DOM here, so the arithmetic is tested without a layout
// engine.

/** A run of a group's rows: drawn (`rows`), or a gap of `px` standing in for
    the rows `start` to `end` (exclusive) that are not mounted. A group's
    window is a list of these in row order, covering every row once. */
export type RowSegment =
  | { kind: 'rows'; start: number; end: number }
  | { kind: 'gap'; start: number; end: number; px: number };

export interface RowWindowInput {
  /** The group's shown rows. */
  count: number;
  /** A row's height in px: measured when it has been drawn, else the
      running estimate. Always positive. */
  heightAt: (index: number) => number;
  /** The list's top edge (row 0's top), in the viewport's coordinates. */
  listTop: number;
  /** The band rows are mounted in, in the same coordinates: the visible
      viewport grown by the overscan on each side (and shrunk under the
      sticky column header). */
  bandTop: number;
  bandBottom: number;
  /** Row indexes kept mounted outside the band (the focused row, the rows
      being dragged); out-of-range indexes are ignored. */
  pinned: readonly number[];
}

/**
 * The segments of one group: the rows whose boxes meet the band, plus the
 * pinned ones, as `rows` runs; everything between and around them as gaps
 * whose px is the sum of the rows they stand for. A list wholly above or
 * below the band is one gap (its header stays mounted either way).
 */
export function windowSegments(input: RowWindowInput): RowSegment[] {
  const { count, heightAt, listTop, bandTop, bandBottom, pinned } = input;
  if (count === 0) return [];
  // One walk down the rows: the first whose bottom passes the band's top
  // and the first whose top reaches its bottom.
  let start = count;
  let end = count;
  let y = listTop;
  for (let i = 0; i < count; i++) {
    if (y >= bandBottom) {
      end = i;
      break;
    }
    const h = heightAt(i);
    if (start === count && y + h > bandTop) start = i;
    y += h;
  }
  if (start >= end) {
    start = 0;
    end = 0;
  }
  const mounted = new Set<number>();
  for (let i = start; i < end; i++) mounted.add(i);
  for (const i of pinned) if (i >= 0 && i < count) mounted.add(i);
  if (mounted.size === 0) {
    return [
      { kind: 'gap', start: 0, end: count, px: sumHeights(heightAt, 0, count) },
    ];
  }
  const order = [...mounted].sort((a, b) => a - b);
  const segments: RowSegment[] = [];
  let at = 0;
  let run: { kind: 'rows'; start: number; end: number } | null = null;
  for (const i of order) {
    if (i > at) {
      run = null;
      segments.push({
        kind: 'gap',
        start: at,
        end: i,
        px: sumHeights(heightAt, at, i),
      });
    }
    if (run !== null && run.end === i) {
      run.end = i + 1;
    } else {
      run = { kind: 'rows', start: i, end: i + 1 };
      segments.push(run);
    }
    at = i + 1;
  }
  if (at < count) {
    segments.push({
      kind: 'gap',
      start: at,
      end: count,
      px: sumHeights(heightAt, at, count),
    });
  }
  return segments;
}

/** The px the rows `from` to `to` (exclusive) take. */
export function sumHeights(
  heightAt: (index: number) => number,
  from: number,
  to: number
): number {
  let px = 0;
  for (let i = from; i < to; i++) px += heightAt(i);
  return px;
}

/** Whether two windows draw the same rows with the same gaps, so a scroll
    that crosses no row edge leaves the group's memoized render alone. */
export function sameSegments(
  a: readonly RowSegment[],
  b: readonly RowSegment[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.kind !== y.kind || x.start !== y.start || x.end !== y.end) {
      return false;
    }
    if (x.kind === 'gap' && y.kind === 'gap' && x.px !== y.px) return false;
  }
  return true;
}

/**
 * The windows before anything has been measured (the server render, and
 * the client's first render, which a layout effect corrects before paint):
 * whole groups in order until `budget` rows are drawn, then one estimated
 * gap per group. Pure in the data, so a server render and its hydration
 * agree. Returns the segments per group, by position in `counts`.
 */
export function initialSegments(
  counts: readonly number[],
  budget: number,
  estimate: number
): RowSegment[][] {
  let left = budget;
  return counts.map((count) => {
    if (count === 0) return [];
    const drawn = Math.min(count, left);
    left -= drawn;
    const segments: RowSegment[] = [];
    if (drawn > 0) segments.push({ kind: 'rows', start: 0, end: drawn });
    if (drawn < count) {
      segments.push({
        kind: 'gap',
        start: drawn,
        end: count,
        px: (count - drawn) * estimate,
      });
    }
    return segments;
  });
}

/** How many rows a window draws. */
export function mountedCount(segments: readonly RowSegment[]): number {
  let n = 0;
  for (const s of segments) if (s.kind === 'rows') n += s.end - s.start;
  return n;
}
