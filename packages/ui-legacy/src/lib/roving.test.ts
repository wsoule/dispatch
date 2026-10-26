import { expect, test } from 'bun:test';

import { nextRovingIndex } from './roving';

test('arrows step and wrap in both directions', () => {
  expect(nextRovingIndex('ArrowRight', 0, 3)).toBe(1);
  expect(nextRovingIndex('ArrowDown', 2, 3)).toBe(0);
  expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2);
  expect(nextRovingIndex('ArrowUp', 1, 3)).toBe(0);
});

test('Home and End jump to the edges', () => {
  expect(nextRovingIndex('Home', 2, 3)).toBe(0);
  expect(nextRovingIndex('End', 0, 3)).toBe(2);
});

test('other keys and empty lists are ignored', () => {
  expect(nextRovingIndex('Enter', 1, 3)).toBeNull();
  expect(nextRovingIndex('a', 1, 3)).toBeNull();
  expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull();
});
