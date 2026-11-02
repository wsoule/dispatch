import { describe, expect, test } from 'bun:test';

import { nearColumnIndexes, sameColumnIndexes } from './boardWindow';

describe('nearColumnIndexes', () => {
  // Seven 340px columns 8px apart on a 1154px-wide board (a 1440px window).
  const spans = Array.from(
    { length: 7 },
    (_, i) => [i * 348, i * 348 + 340] as const
  );
  const near = (scrollLeft: number, margin: number) => [
    ...(nearColumnIndexes(spans, scrollLeft, 1154, margin) ?? []),
  ];
  test('columns reaching within half a width of the window are near', () => {
    expect(near(0, 0.5)).toEqual([0, 1, 2, 3, 4]);
    expect(near(1100, 0.5)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  test('without a margin, only the visible ones', () => {
    expect(near(0, 0)).toEqual([0, 1, 2, 3]);
  });
  test('nothing to measure keeps every column near', () => {
    expect(nearColumnIndexes(spans, 0, 0, 0.5)).toBeNull();
    expect(nearColumnIndexes([], 0, 1154, 0.5)).toBeNull();
  });
  test('sameColumnIndexes compares by members', () => {
    expect(sameColumnIndexes(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameColumnIndexes(new Set([1, 2]), new Set([1]))).toBe(false);
    expect(sameColumnIndexes(null, null)).toBe(true);
    expect(sameColumnIndexes(null, new Set())).toBe(false);
  });
});
