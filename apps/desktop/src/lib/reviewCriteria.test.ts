import { expect, test } from 'bun:test';

import {
  criteriaItems,
  readCriteriaChecks,
  writeCriteriaChecks,
} from './reviewCriteria';

test('criteriaItems reads one criterion per line, whatever its bullet', () => {
  expect(
    criteriaItems('- tests pass\n\n* [x] docs updated\n1. [ ] no regressions\n')
  ).toEqual(['tests pass', 'docs updated', 'no regressions']);
});

test('checks round-trip per run and survive a broken store', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  writeCriteriaChecks('r-1', new Set([0, 2]), storage);
  expect([...readCriteriaChecks('r-1', storage)]).toEqual([0, 2]);
  expect(readCriteriaChecks('r-2', storage).size).toBe(0);

  store.set('dispatch:review-criteria:r-3', 'not json');
  expect(readCriteriaChecks('r-3', storage).size).toBe(0);
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(readCriteriaChecks('r-1', throwing).size).toBe(0);
  expect(() =>
    writeCriteriaChecks('r-1', new Set([1]), throwing)
  ).not.toThrow();
});
