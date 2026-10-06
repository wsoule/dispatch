import { describe, expect, test } from 'bun:test';

import { docked, restored } from './overseerDock';

describe('the Overseer dock', () => {
  test('docking puts a conversation first, once', () => {
    expect(docked(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(docked([], 'a')).toEqual(['a']);
  });

  test('restoring swaps the open conversation into the dock', () => {
    expect(restored(['a', 'b'], 'b', 'c')).toEqual(['c', 'a']);
    expect(restored(['a', 'b'], 'b', null)).toEqual(['a']);
    expect(restored(['a'], 'a', 'a')).toEqual([]);
  });
});
