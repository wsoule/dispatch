import { expect, test } from 'bun:test';

import { filterByPath, groupByHop } from './impactGroups.js';

const entries = [
  { path: 'src/a.ts', hops: 1 },
  { path: 'src/b.ts', hops: 1 },
  { path: 'test/c.ts', hops: 2 },
];

test('groups by hop distance, closest first', () => {
  expect(groupByHop(entries)).toEqual([
    { hops: 1, paths: ['src/a.ts', 'src/b.ts'] },
    { hops: 2, paths: ['test/c.ts'] },
  ]);
});

test('an empty list groups to nothing', () => {
  expect(groupByHop([])).toEqual([]);
});

test('the filter matches on any part of the path, case-insensitively', () => {
  expect(filterByPath(entries, 'SRC/')).toHaveLength(2);
  expect(filterByPath(entries, 'c.ts')).toHaveLength(1);
});

test('an empty filter returns everything rather than nothing', () => {
  expect(filterByPath(entries, '')).toHaveLength(3);
});
