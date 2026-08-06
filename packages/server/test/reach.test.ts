import { expect, test } from 'bun:test';

import type { DepMap } from '../src/depmap.js';
import { reachOver } from '../src/depmap.js';

// A scanner-shaped stub: importer -> the files it is a dependent of.
function scannerOf(graph: Record<string, string[]>): DepMap {
  return {
    dependents: (file) => graph[file] ?? [],
    mirrors: () => [],
    reach: () => {
      throw new Error('unused');
    },
  };
}

test('walks transitively and records distance', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries).toEqual([
    { path: 'b.ts', hops: 1 },
    { path: 'c.ts', hops: 2 },
  ]);
  expect(result.maxHops).toBe(2);
  expect(result.truncated).toBe(false);
});

test('terminates on a cycle', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
});

test('a diamond records the shortest distance', () => {
  const map = scannerOf({
    'a.ts': ['b.ts', 'd.ts'],
    'b.ts': ['c.ts'],
    'c.ts': ['d.ts'],
  });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.entries.find((e) => e.path === 'd.ts')?.hops).toBe(1);
});

test('the seed files are never reported as their own dependents', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] });
  const result = reachOver(map, ['a.ts', 'b.ts'], {
    maxHops: 5,
    maxFiles: 500,
  });
  expect(result.entries).toEqual([]);
});

test('the hop cap stops the walk and sets truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 1, maxFiles: 500 });
  expect(result.entries).toEqual([{ path: 'b.ts', hops: 1 }]);
  expect(result.truncated).toBe(true);
});

test('the file cap stops the walk and sets truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts', 'c.ts', 'd.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 2 });
  expect(result.count).toBe(2);
  expect(result.truncated).toBe(true);
});

test('an exhausted walk is not marked truncated', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  expect(result.truncated).toBe(false);
});

test('results are ordered by distance, never interleaved by source', () => {
  const map = scannerOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] });
  const result = reachOver(map, ['a.ts'], { maxHops: 5, maxFiles: 500 });
  const hops = result.entries.map((e) => e.hops);
  expect(hops).toEqual([...hops].sort((x, y) => x - y));
});
