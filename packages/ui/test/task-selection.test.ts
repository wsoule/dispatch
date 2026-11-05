import { describe, expect, test } from 'bun:test';

import { pruneSelection, rangeIds, setIds, toggleId } from '../src/index';

// The selection helpers TaskGroupTable and its hosts share: pure, never
// mutating their input, and returning the same set when nothing changes
// (so a host's state update can bail out).

const ORDER = ['eng-1', 'eng-2', 'eng-3', 'ops-1', 'ops-2'];

describe('toggleId', () => {
  test('adds a missing id and removes a present one, leaving the input alone', () => {
    const base = new Set(['eng-1']);
    expect(toggleId(base, 'eng-2')).toEqual(new Set(['eng-1', 'eng-2']));
    expect(toggleId(base, 'eng-1')).toEqual(new Set());
    expect(base).toEqual(new Set(['eng-1']));
  });
});

describe('rangeIds', () => {
  test('runs from anchor to target inclusive, in either direction', () => {
    expect(rangeIds(ORDER, 'eng-2', 'ops-1')).toEqual([
      'eng-2',
      'eng-3',
      'ops-1',
    ]);
    expect(rangeIds(ORDER, 'ops-1', 'eng-2')).toEqual([
      'eng-2',
      'eng-3',
      'ops-1',
    ]);
    expect(rangeIds(ORDER, 'eng-3', 'eng-3')).toEqual(['eng-3']);
  });

  test('a missing anchor starts at the target; a missing target is empty', () => {
    expect(rangeIds(ORDER, 'gone', 'ops-2')).toEqual(['ops-2']);
    expect(rangeIds(ORDER, 'eng-1', 'gone')).toEqual([]);
  });
});

describe('setIds', () => {
  test('turns ids on or off and keeps identity when nothing changes', () => {
    const base: ReadonlySet<string> = new Set(['eng-1', 'eng-2']);
    expect(setIds(base, ['eng-2', 'eng-3'], true)).toEqual(
      new Set(['eng-1', 'eng-2', 'eng-3'])
    );
    expect(setIds(base, ['eng-1', 'ops-1'], false)).toEqual(new Set(['eng-2']));
    expect(setIds(base, ['eng-1', 'eng-2'], true)).toBe(base);
    expect(setIds(base, ['ops-1'], false)).toBe(base);
    expect(base).toEqual(new Set(['eng-1', 'eng-2']));
  });
});

describe('pruneSelection', () => {
  test('keeps only shown ids, and the same set when all are shown', () => {
    const base: ReadonlySet<string> = new Set(['eng-1', 'ops-1']);
    expect(pruneSelection(base, new Set(['eng-1', 'eng-2']))).toEqual(
      new Set(['eng-1'])
    );
    expect(pruneSelection(base, new Set(ORDER))).toBe(base);
    expect(pruneSelection(base, new Set())).toEqual(new Set());
  });
});
