import { describe, expect, test } from 'bun:test';

import { shouldRecluster } from './inboxAutoCluster';

const MIN_ITEMS = 3;

describe('shouldRecluster', () => {
  test('below the minimum item count, never reclusters', () => {
    expect(shouldRecluster(['a', 'b'], null, MIN_ITEMS)).toBe(false);
    expect(shouldRecluster(['a', 'b'], ['a', 'b'], MIN_ITEMS)).toBe(false);
  });

  test('first run — a null baseline reclusters once at the minimum', () => {
    expect(shouldRecluster(['a', 'b', 'c'], null, MIN_ITEMS)).toBe(true);
  });

  test('asked again with the exact same set already clustered — no-op', () => {
    expect(shouldRecluster(['a', 'b', 'c'], ['a', 'b', 'c'], MIN_ITEMS)).toBe(
      false
    );
  });

  test('the set changed (an item added or removed) — reclusters', () => {
    expect(
      shouldRecluster(['a', 'b', 'c', 'd'], ['a', 'b', 'c'], MIN_ITEMS)
    ).toBe(true);
    expect(shouldRecluster(['a', 'b', 'd'], ['a', 'b', 'c'], MIN_ITEMS)).toBe(
      true
    );
  });

  test('reordered but the same membership — not a change, no-op', () => {
    expect(shouldRecluster(['c', 'a', 'b'], ['a', 'b', 'c'], MIN_ITEMS)).toBe(
      false
    );
  });
});
