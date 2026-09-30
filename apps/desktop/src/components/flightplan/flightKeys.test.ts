import { describe, expect, test } from 'bun:test';

import {
  flightNavIndex,
  moveFlightCursor,
  resolveFlightKey,
} from './flightKeys';
import type { FlightBox } from './flightLayout';

// Column 0: a (y 0), b (y 60), c (y 120); column 1: d (y 60); column 3: e (y 0).
const boxes = new Map<string, FlightBox>(
  (
    [
      ['a', 0, 0],
      ['b', 0, 60],
      ['c', 0, 120],
      ['d', 1, 60],
      ['e', 3, 0],
    ] as const
  ).map(([id, column, y]) => [
    id,
    { id, column, y, x: column * 300, wave: column },
  ])
);
const index = flightNavIndex(boxes);

describe('moveFlightCursor', () => {
  test('no cursor starts top-left', () => {
    expect(moveFlightCursor(index, null, 'down')).toBe('a');
  });

  test('up and down walk a column and stop at its ends', () => {
    expect(moveFlightCursor(index, 'a', 'down')).toBe('b');
    expect(moveFlightCursor(index, 'c', 'down')).toBe('c');
    expect(moveFlightCursor(index, 'a', 'up')).toBe('a');
  });

  test('left and right land on the nearest node by height, skipping empty columns', () => {
    expect(moveFlightCursor(index, 'c', 'right')).toBe('d');
    expect(moveFlightCursor(index, 'd', 'left')).toBe('b');
    expect(moveFlightCursor(index, 'd', 'right')).toBe('e');
    expect(moveFlightCursor(index, 'e', 'right')).toBe('e');
  });
});

test('resolveFlightKey', () => {
  const key = (k: string, mod = false) =>
    resolveFlightKey({ key: k, metaKey: mod, ctrlKey: false, altKey: false });
  expect(key('ArrowRight')).toBe('right');
  expect(key('j')).toBe('down');
  expect(key('Enter')).toBe('open');
  expect(key('d')).toBe('dispatch');
  expect(key('Escape')).toBe('close');
  expect(key('d', true)).toBeNull();
  expect(key('x')).toBeNull();
});
