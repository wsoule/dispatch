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
});
