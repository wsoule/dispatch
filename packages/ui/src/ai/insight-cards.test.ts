import { describe, expect, test } from 'bun:test';

import {
  indexFromOffsetX,
  pathFromSeries,
  pointsFromSeries,
} from './insight-cards';

describe('pointsFromSeries', () => {
  test('returns no points for an empty series', () => {
    expect(pointsFromSeries([], 100, 40)).toEqual([]);
  });

  test('centers a single-value series in the viewbox without NaN', () => {
    const points = pointsFromSeries([7], 100, 40);
    expect(points).toEqual([{ x: 50, y: 20 }]);
  });

  test('centers a flat multi-point series vertically, spreading x across the viewbox', () => {
    const points = pointsFromSeries([3, 3, 3], 90, 40);
    expect(points).toEqual([
      { x: 0, y: 20 },
      { x: 45, y: 20 },
      { x: 90, y: 20 },
    ]);
  });

  test('normalizes an ascending series to the full viewbox height, min at bottom', () => {
    const points = pointsFromSeries([1, 2, 3], 100, 40);
    expect(points).toEqual([
      { x: 0, y: 40 },
      { x: 50, y: 20 },
      { x: 100, y: 0 },
    ]);
  });

  test('never produces NaN coordinates', () => {
    const points = pointsFromSeries([1, 1, 5, -2], 120, 60);
    for (const point of points) {
      expect(Number.isNaN(point.x)).toBe(false);
      expect(Number.isNaN(point.y)).toBe(false);
    }
  });
});

describe('pathFromSeries', () => {
  test('returns an empty path for an empty series', () => {
    expect(pathFromSeries([], 100, 40)).toBe('');
  });

  test('builds a single moveto for a length-1 series without NaN', () => {
    expect(pathFromSeries([9], 100, 40)).toBe('M50,20');
  });

  test('builds a moveto followed by linetos for a multi-point series', () => {
    expect(pathFromSeries([1, 2, 3], 100, 40)).toBe('M0,40 L50,20 L100,0');
  });

  test('never contains NaN for a flat series', () => {
    expect(pathFromSeries([5, 5, 5, 5], 90, 40)).not.toContain('NaN');
  });
});

describe('indexFromOffsetX', () => {
  test('returns -1 for an empty series', () => {
    expect(indexFromOffsetX(10, 100, 0)).toBe(-1);
  });

  test('always returns 0 for a single-point series', () => {
    expect(indexFromOffsetX(80, 100, 1)).toBe(0);
  });

  test('clamps offsets before the start to index 0', () => {
    expect(indexFromOffsetX(-20, 100, 5)).toBe(0);
  });

  test('clamps offsets past the end to the last index', () => {
    expect(indexFromOffsetX(500, 100, 5)).toBe(4);
  });

  test('rounds to the nearest index across the width', () => {
    expect(indexFromOffsetX(0, 100, 5)).toBe(0);
    expect(indexFromOffsetX(25, 100, 5)).toBe(1);
    expect(indexFromOffsetX(50, 100, 5)).toBe(2);
    expect(indexFromOffsetX(75, 100, 5)).toBe(3);
    expect(indexFromOffsetX(100, 100, 5)).toBe(4);
  });

  test('treats zero width as index 0', () => {
    expect(indexFromOffsetX(10, 0, 5)).toBe(0);
  });
});
