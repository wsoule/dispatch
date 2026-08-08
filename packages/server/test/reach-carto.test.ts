import type { CartoBlastRadius } from '@dispatch/core/carto';
import { expect, test } from 'bun:test';

import {
  createCartoDepMap,
  DEFAULT_REACH,
  type DepMap,
  reachOver,
} from '../src/depmap.js';

// A scanner-shaped DepMap built from a ONE-HOP adjacency list. It derives
// transitive distance itself, because the real DepMap's dependentsWithHops
// returns the whole closure with distances — a stub that returned one-hop
// entries would not be a valid DepMap. Mirror the equivalent helper already in
// packages/server/test/reach.test.ts rather than inventing a second shape.
function scannerOf(graph: Record<string, string[]>): DepMap {
  const map: DepMap = {
    dependentsWithHops(file) {
      const depth = new Map<string, number>();
      let frontier = [file];
      let hops = 0;
      while (frontier.length > 0) {
        hops++;
        const next: string[] = [];
        for (const current of frontier) {
          for (const importer of graph[current] ?? []) {
            if (importer === file || depth.has(importer)) continue;
            depth.set(importer, hops);
            next.push(importer);
          }
        }
        frontier = next;
      }
      return [...depth.entries()]
        .sort(([pa, ha], [pb, hb]) =>
          ha !== hb ? ha - hb : pa < pb ? -1 : pa > pb ? 1 : 0
        )
        .map(([path, h]) => ({ path, hops: h }));
    },
    dependents: (file) => map.dependentsWithHops(file).map((e) => e.path),
    mirrors: () => [],
    reach: (files, opts) =>
      reachOver(map, files, { ...DEFAULT_REACH, ...opts }),
  };
  return map;
}

// Minimal reader returning fixed carto answers per file.
function readerOf(answers: Record<string, CartoBlastRadius>) {
  return {
    blastRadius: (file: string) =>
      answers[file] ?? { count: 0, hops: 0, files: [] },
  };
}

test('a file both graphs reach is recorded at the shorter distance', () => {
  const scanner = scannerOf({ 'a.ts': ['near.ts'] });
  const reader = readerOf({
    'a.ts': {
      count: 1,
      hops: 2,
      files: [{ file: 'near.ts', hop_distance: 2 }],
    },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'near.ts', hops: 1 }]);
});

test('carto-only files survive the union', () => {
  const scanner = scannerOf({ 'a.ts': [] });
  const reader = readerOf({
    'a.ts': { count: 1, hops: 3, files: [{ file: 'far.py', hop_distance: 3 }] },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'far.py', hops: 3 }]);
  expect(result.sources).toEqual(['carto', 'scanner']);
});

test('carto reporting a shorter distance than the scanner wins', () => {
  // Scanner reaches x.ts only via a 3-hop chain; carto's own transitive
  // closure gets there in 1. Carto's shorter distance must win, and the
  // `existing <= entry.hops` skip-branch must not fire for it.
  const scanner = scannerOf({
    'a.ts': ['b.ts'],
    'b.ts': ['c.ts'],
    'c.ts': ['x.ts'],
  });
  const reader = readerOf({
    'a.ts': {
      count: 1,
      hops: 1,
      files: [{ file: 'x.ts', hop_distance: 1 }],
    },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries.find((e) => e.path === 'x.ts')).toEqual({
    path: 'x.ts',
    hops: 1,
  });
});

test('a carto entry beyond maxHops is dropped AND reported as truncated', () => {
  // Reproduces C1: the scanner reaches nothing past the hop budget, but
  // carto's own closure finds far.py at hop 9 with maxHops: 5. Silently
  // dropping it (no truncated flag) would make the caller believe the
  // count of 0 is exact, when in fact something real was excluded.
  const scanner = scannerOf({ 'a.ts': [] });
  const reader = readerOf({
    'a.ts': {
      count: 1,
      hops: 9,
      files: [{ file: 'far.py', hop_distance: 9 }],
    },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries).toEqual([]);
  expect(result.count).toBe(0);
  expect(result.truncated).toBe(true);
});

test('an exact-boundary result with nothing dropped is NOT reported as truncated', () => {
  // Reproduces I1: the scanner returns exactly maxFiles entries and carto
  // adds nothing new. Nothing was capped, so `truncated` must stay false —
  // `closest.size >= maxFiles` alone can never distinguish "exactly full"
  // from "something got rejected".
  const scanner: DepMap = {
    dependentsWithHops: () => [
      { path: 'a.ts', hops: 1 },
      { path: 'b.ts', hops: 1 },
    ],
    dependents: () => ['a.ts', 'b.ts'],
    mirrors: () => [],
    reach: (files, opts) =>
      reachOver(scanner, files, { ...DEFAULT_REACH, ...opts }),
  };
  const reader = readerOf({});
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['seed.ts'], { maxHops: 5, maxFiles: 2 });
  expect(result.count).toBe(2);
  expect(result.truncated).toBe(false);
});

test('a carto entry blocked by an already-full file cap still reports truncated', () => {
  // The exact-boundary case above must not overcorrect: when closest is
  // already at maxFiles and carto offers a genuinely new path, that entry
  // really is rejected, and truncated must say so.
  const scanner: DepMap = {
    dependentsWithHops: () => [
      { path: 'a.ts', hops: 1 },
      { path: 'b.ts', hops: 1 },
    ],
    dependents: () => ['a.ts', 'b.ts'],
    mirrors: () => [],
    reach: (files, opts) =>
      reachOver(scanner, files, { ...DEFAULT_REACH, ...opts }),
  };
  const reader = readerOf({
    'seed.ts': {
      count: 1,
      hops: 1,
      files: [{ file: 'c.ts', hop_distance: 1 }],
    },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['seed.ts'], { maxHops: 5, maxFiles: 2 });
  expect(result.count).toBe(2);
  expect(result.entries.map((e) => e.path)).not.toContain('c.ts');
  expect(result.truncated).toBe(true);
});

test('carto active: a non-.ts seed is never flagged unanalyzed, since carto is multi-language', () => {
  const scanner = scannerOf({});
  const reader = readerOf({
    'main.py': {
      count: 1,
      hops: 1,
      files: [{ file: 'other.py', hop_distance: 1 }],
    },
  });
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['main.py']);
  expect(result.sources).toEqual(['carto', 'scanner']);
  expect(result.unanalyzedSeeds).toEqual([]);
});

test('a throwing reader degrades to the scanner and says so', () => {
  const scanner = scannerOf({ 'a.ts': ['b.ts'] });
  const reader = {
    blastRadius(): CartoBlastRadius {
      throw new Error('container half-written');
    },
  };
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['a.ts']);
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
  expect(result.sources).toEqual(['scanner']);
  expect(result.degraded).toBe(true);
  expect(result.unanalyzedSeeds).toEqual([]);
});

test('a degraded reader still flags a non-.ts seed unanalyzed, since it fell back to the scanner alone', () => {
  const scanner = scannerOf({});
  const reader = {
    blastRadius(): CartoBlastRadius {
      throw new Error('container half-written');
    },
  };
  const map = createCartoDepMap('/repo', reader, scanner);
  const result = map.reach(['notes.jsonl']);
  expect(result.degraded).toBe(true);
  expect(result.unanalyzedSeeds).toEqual(['notes.jsonl']);
});
