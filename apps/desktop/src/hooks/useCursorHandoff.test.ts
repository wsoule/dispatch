import { describe, expect, test } from 'bun:test';

import { handoffTarget } from './useCursorHandoff';

describe('handoffTarget', () => {
  test('a row still at its place keeps the cursor', () => {
    expect(handoffTarget(['a', 'b', 'c'], { id: 'b', index: 1 })).toBe(
      undefined
    );
  });

  test('a row that moved hands the cursor to the one now in its place', () => {
    expect(handoffTarget(['a', 'c', 'b'], { id: 'b', index: 1 })).toBe('c');
    expect(handoffTarget(['a'], { id: 'b', index: 1 })).toBe('a');
    expect(handoffTarget([], { id: 'b', index: 1 })).toBe(null);
  });
});
