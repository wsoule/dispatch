import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BlastEntry, DepMap } from '../src/depmap.js';
import { buildDepMap, reachOver, sortEntries } from '../src/depmap.js';

// A scanner-shaped stub: `graph[file]` lists the files that directly
// (one-hop) depend on `file`. dependentsWithHops walks that one-hop graph
// itself to produce the full transitive closure with hop distance — the same
// shape a real DepMap exposes, not the one-hop edges reachOver used to walk.
function scannerOf(graph: Record<string, string[]>): DepMap {
  function dependentsWithHops(file: string): BlastEntry[] {
    const depth = new Map<string, number>([[file, 0]]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const importer of graph[current] ?? []) {
        if (!depth.has(importer)) {
          depth.set(importer, (depth.get(current) as number) + 1);
          queue.push(importer);
        }
      }
    }
    depth.delete(file);
    return sortEntries(depth);
  }
  return {
    dependents: (file) => dependentsWithHops(file).map((e) => e.path),
    dependentsWithHops,
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

// Regression: dependentsWithHops must expose the hop distance the scanner's
// own BFS already computes, not have reachOver re-derive it by walking
// dependents() as if every edge were one hop. A stub can't catch this — only
// the real buildDepMap's BFS proves hop distance survives past two hops.
test('reach over the real buildDepMap keeps hop distance past one hop', () => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-reach-'));
  try {
    // c imports b, b imports a: a's blast radius is b at 1 hop, c at 2.
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(root, 'b.ts'),
      "import './a.js';\nexport const b = 1;\n"
    );
    writeFileSync(
      join(root, 'c.ts'),
      "import './b.js';\nexport const c = 1;\n"
    );
    const map = buildDepMap(root);
    const result = map.reach(['a.ts']);
    expect(result.entries).toEqual([
      { path: 'b.ts', hops: 1 },
      { path: 'c.ts', hops: 2 },
    ]);
    expect(result.maxHops).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
