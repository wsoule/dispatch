import { splitLines } from './sections.js';

// Docs' own line diff and diff3: patience anchors, a linear-space Myers bisect
// in gaps, and a deterministic work budget, so a merge at the body cap stays
// fast on the daemon's one thread and every replica computes the same bytes.

export const MERGE_ALGO = 'diff3-patience/1';
export const DIFF_WORK = 2_000_000;

interface Work {
  n: number;
  budget: number;
}

// Counts one unit of work; false once the budget is spent. Stops at budget + 1.
function tick(w: Work): boolean {
  if (w.n > w.budget) return false;
  w.n += 1;
  return w.n <= w.budget;
}

const spent = (w: Work): boolean => w.n > w.budget;

export interface LineDiff {
  matches: Array<[number, number]>;
  work: number;
  spent: boolean;
}

// Maps each distinct line to an integer for this call only.
function intern(
  a: readonly string[],
  b: readonly string[]
): { ia: Int32Array; ib: Int32Array } {
  const ids = new Map<string, number>();
  const map = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  return { ia: map(a), ib: map(b) };
}

// Pairs sorted by `a` kept to the longest run increasing in `b` (patience sorting).
function longestIncreasing(
  pairs: Array<[number, number]>,
  w: Work
): Array<[number, number]> {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    if (!tick(w)) return [];
    const bj = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < bj) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: Array<[number, number]> = [];
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    out.push(pairs[k]);
    k = prev[k];
  }
  return out.reverse();
}

// Lines occurring exactly once in each range, paired and kept in order on both sides.
function uniqueAnchors(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  w: Work
): Array<[number, number]> {
  const inA = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) {
    if (!tick(w)) return [];
    inA.set(a[i], inA.has(a[i]) ? -1 : i);
  }
  const inB = new Map<number, number>();
  for (let j = bLo; j < bHi; j++) {
    if (!tick(w)) return [];
    inB.set(b[j], inB.has(b[j]) ? -1 : j);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = aLo; i < aHi; i++) {
    if (inA.get(a[i]) !== i) continue;
    const j = inB.get(a[i]);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  return longestIncreasing(pairs, w);
}

// The middle snake of a[aLo,aHi) and b[bLo,bHi) (diff-match-patch's bisect),
// as the point to split at, or null when the budget runs out first.
function bisect(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  w: Work
): { x: number; y: number } | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD + 1;
  const size = 2 * maxD + 3;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      if (!tick(w)) return null;
      const k1o = off + k1;
      let x1 =
        k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1])
          ? v1[k1o + 1]
          : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        if (!tick(w)) return null;
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < size && v2[k2o] !== -1 && x1 >= n - v2[k2o]) {
          return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      if (!tick(w)) return null;
      const k2o = off + k2;
      let x2 =
        k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1])
          ? v2[k2o + 1]
          : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        if (!tick(w)) return null;
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < size && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return { x: aLo + x1, y: bLo + y1 };
        }
      }
    }
  }
  return null;
}

type RangeDiff = (
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  out: Array<[number, number]>,
  w: Work
) => void;

// Trims the range's common prefix and suffix, runs `middle` on what is left,
// and emits matches in increasing order.
function trimmed(middle: RangeDiff): RangeDiff {
  return (a, aLo0, aHi, b, bLo0, bHi, out, w) => {
    let aLo = aLo0;
    let bLo = bLo0;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo] && tick(w)) {
      out.push([aLo, bLo]);
      aLo++;
      bLo++;
    }
    let aEnd = aHi;
    let bEnd = bHi;
    while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1] && tick(w)) {
      aEnd--;
      bEnd--;
    }
    if (aLo < aEnd && bLo < bEnd && !spent(w))
      middle(a, aLo, aEnd, b, bLo, bEnd, out, w);
    for (let k = 0; k < aHi - aEnd; k++) out.push([aEnd + k, bEnd + k]);
  };
}

const myers: RangeDiff = trimmed((a, aLo, aHi, b, bLo, bHi, out, w) => {
  const split = bisect(a, aLo, aHi, b, bLo, bHi, w);
  if (split === null) return;
  myers(a, aLo, split.x, b, bLo, split.y, out, w);
  myers(a, split.x, aHi, b, split.y, bHi, out, w);
});

const patience: RangeDiff = trimmed((a, aLo, aHi, b, bLo, bHi, out, w) => {
  const anchors = uniqueAnchors(a, aLo, aHi, b, bLo, bHi, w);
  if (anchors.length === 0) {
    myers(a, aLo, aHi, b, bLo, bHi, out, w);
    return;
  }
  let pa = aLo;
  let pb = bLo;
  for (const [i, j] of anchors) {
    patience(a, pa, i, b, pb, j, out, w);
    out.push([i, j]);
    pa = i + 1;
    pb = j + 1;
  }
  patience(a, pa, aHi, b, pb, bHi, out, w);
});

// Equal line pairs between `a` and `b`; unmatched lines are the changes.
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  budget = DIFF_WORK
): LineDiff {
  const { ia, ib } = intern(a, b);
  const w: Work = { n: 0, budget };
  const matches: Array<[number, number]> = [];
  patience(ia, 0, ia.length, ib, 0, ib.length, matches, w);
  return { matches, work: w.n, spent: spent(w) };
}

// Pushes lines one by one: a spread of a cap-sized body's lines overflows the call stack.
function append(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}

export interface DiffChunk {
  equal: boolean;
  a: string[];
  b: string[];
}

// Runs of equal and changed lines between two bodies, for history views.
export function diffChunks(
  aText: string,
  bText: string,
  budget = DIFF_WORK
): { chunks: DiffChunk[]; spent: boolean } {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const d = diffLines(a, b, budget);
  const chunks: DiffChunk[] = [];
  let i = 0;
  let j = 0;
  const push = (equal: boolean, al: string[], bl: string[]): void => {
    if (al.length === 0 && bl.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.equal === equal) {
      append(last.a, al);
      append(last.b, bl);
    } else chunks.push({ equal, a: al, b: bl });
  };
  for (const [mi, mj] of d.matches) {
    push(false, a.slice(i, mi), b.slice(j, mj));
    push(true, [a[mi]], [b[mj]]);
    i = mi + 1;
    j = mj + 1;
  }
  push(false, a.slice(i), b.slice(j));
  return { chunks, spent: d.spent };
}

export interface MergeLabels {
  head: string;
  base: string;
  mine: string;
}

interface MergeHunk {
  line: number;
  base: string[];
  head: string[];
  mine: string[];
}

export type MergeResult =
  | { clean: true; body: string; spent: boolean }
  | { clean: false; hunks: MergeHunk[]; marked: string; spent: boolean };

function sameLines(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((line, k) => line === y[k]);
}

// A segment ready for a marker line after it: its last line ends in a newline.
function closed(lines: readonly string[]): string[] {
  if (lines.length === 0 || lines[lines.length - 1].endsWith('\n'))
    return [...lines];
  return [...lines.slice(0, -1), `${lines[lines.length - 1]}\n`];
}

// diff3 of base, head and mine over two line diffs: stable chunks where both
// sides keep a base line in place, unstable chunks between them.
export function merge3(
  base: string,
  head: string,
  mine: string,
  labels: MergeLabels,
  budget = DIFF_WORK
): MergeResult {
  const o = splitLines(base);
  const a = splitLines(head);
  const b = splitLines(mine);
  const da = diffLines(o, a, budget);
  const db = diffLines(o, b, budget);
  const aOf = new Int32Array(o.length).fill(-1);
  for (const [i, j] of da.matches) aOf[i] = j;
  const bOf = new Int32Array(o.length).fill(-1);
  for (const [i, j] of db.matches) bOf[i] = j;

  const out: string[] = [];
  const marked: string[] = [];
  const hunks: MergeHunk[] = [];
  const emit = (lines: readonly string[]): void => {
    append(out, lines);
    append(marked, lines);
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    let s = 0;
    while (
      io + s < o.length &&
      aOf[io + s] === ia + s &&
      bOf[io + s] === ib + s
    )
      s++;
    if (s > 0) {
      emit(o.slice(io, io + s));
      io += s;
      ia += s;
      ib += s;
      continue;
    }
    let next = io;
    while (next < o.length && (aOf[next] === -1 || bOf[next] === -1)) next++;
    const aNext = next < o.length ? aOf[next] : a.length;
    const bNext = next < o.length ? bOf[next] : b.length;
    const oSeg = o.slice(io, next);
    const aSeg = a.slice(ia, aNext);
    const bSeg = b.slice(ib, bNext);
    if (oSeg.length === 0 && aSeg.length === 0 && bSeg.length === 0) break;
    if (sameLines(aSeg, oSeg)) emit(bSeg);
    else if (sameLines(bSeg, oSeg) || sameLines(aSeg, bSeg)) emit(aSeg);
    else {
      hunks.push({ line: ia + 1, base: oSeg, head: aSeg, mine: bSeg });
      marked.push(`<<<<<<< ${labels.head}\n`);
      append(marked, closed(aSeg));
      marked.push(`||||||| ${labels.base}\n`);
      append(marked, closed(oSeg));
      marked.push('=======\n');
      append(marked, closed(bSeg));
      marked.push(`>>>>>>> ${labels.mine}\n`);
    }
    io = next;
    ia = aNext;
    ib = bNext;
  }
  const wasSpent = da.spent || db.spent;
  if (hunks.length === 0)
    return { clean: true, body: joinLines(out), spent: wasSpent };
  return { clean: false, hunks, marked: joinLines(marked), spent: wasSpent };
}

// Joins merged lines. Only a file's last line lacks a newline; if one lands
// mid-body (a side's last line followed by more text), it gets one.
function joinLines(lines: readonly string[]): string {
  return lines
    .map((line, k) =>
      k < lines.length - 1 && !line.endsWith('\n') ? `${line}\n` : line
    )
    .join('');
}
