import { describe, expect, test } from 'bun:test';

import { flowRows } from './flowList';

const key = (s: string) => s;

describe('flowRows', () => {
  test('current rows first, then the ones on their way out', () => {
    expect(flowRows(['a', 'b'], key, new Map([['c', 'c']]))).toEqual([
      { key: 'a', item: 'a', leaving: false },
      { key: 'b', item: 'b', leaving: false },
      { key: 'c', item: 'c', leaving: true },
    ]);
  });

  test('an item that comes back is current, not leaving', () => {
    expect(flowRows(['a'], key, new Map([['a', 'a']]))).toEqual([
      { key: 'a', item: 'a', leaving: false },
    ]);
  });
});
