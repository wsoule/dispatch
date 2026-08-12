import { describe, expect, test } from 'bun:test';

import type { SearchGroup, SearchItem } from './search';
import { filterGroups, moveActive, resolveActiveId } from './search';

const GROUPS: SearchGroup[] = [
  {
    id: 'tasks',
    label: 'Tasks',
    items: [
      { id: 't-716d89', label: 'Rework the kanban columns' },
      { id: 't-cafe27', label: 'Boot force-fail must say why' },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    items: [
      { id: 'a-warden', label: 'Warden' },
      { id: 'a-cartographer', label: 'Cartographer' },
    ],
  },
  {
    id: 'commands',
    label: 'Commands',
    items: [{ id: 'c-new-run', label: 'Start a new run' }],
  },
];

describe('filterGroups', () => {
  test('returns all groups unchanged when the query is empty', () => {
    const result = filterGroups(GROUPS, '');
    expect(result).toEqual(GROUPS);
  });

  test('returns all groups unchanged when the query is only whitespace', () => {
    const result = filterGroups(GROUPS, '   ');
    expect(result).toEqual(GROUPS);
  });

  test('matches item labels by case-insensitive substring', () => {
    const result = filterGroups(GROUPS, 'WARDEN');
    expect(result).toEqual([
      {
        id: 'agents',
        label: 'Agents',
        items: [{ id: 'a-warden', label: 'Warden' }],
      },
    ]);
  });

  test('drops groups whose items all fail to match', () => {
    const result = filterGroups(GROUPS, 'kanban');
    expect(result.map((group) => group.id)).toEqual(['tasks']);
    expect(result[0]?.items).toEqual([
      { id: 't-716d89', label: 'Rework the kanban columns' },
    ]);
  });

  test('matches across multiple groups at once', () => {
    const result = filterGroups(GROUPS, 'a');
    // "Rework the kanban columns" (a), "Warden" (a), "Cartographer" (a), "Start a new run" (a)
    expect(result.map((group) => group.id)).toEqual([
      'tasks',
      'agents',
      'commands',
    ]);
  });

  test('returns an empty array when nothing matches', () => {
    const result = filterGroups(GROUPS, 'zzz-no-match');
    expect(result).toEqual([]);
  });

  test('does not mutate the input groups', () => {
    const before = JSON.parse(JSON.stringify(GROUPS));
    filterGroups(GROUPS, 'warden');
    expect(GROUPS).toEqual(before);
  });
});

const ITEMS: SearchItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
];
const SOLO: SearchItem[] = [{ id: 'a', label: 'Alpha' }];

describe('resolveActiveId', () => {
  test('keeps activeId when it is present in items', () => {
    expect(resolveActiveId(ITEMS, 'b')).toBe('b');
  });

  test('falls back to the first item when activeId is not in items', () => {
    expect(resolveActiveId(ITEMS, 'ghost')).toBe('a');
  });

  test('falls back to the first item when activeId is null', () => {
    expect(resolveActiveId(ITEMS, null)).toBe('a');
  });

  test('returns null for an empty item list regardless of activeId', () => {
    expect(resolveActiveId([], 'a')).toBeNull();
    expect(resolveActiveId([], null)).toBeNull();
  });
});

describe('moveActive', () => {
  test('returns null for an empty item list', () => {
    expect(moveActive([], 'a', 'next')).toBeNull();
    expect(moveActive([], null, 'previous')).toBeNull();
  });

  test('a single item wraps to itself in both directions', () => {
    expect(moveActive(SOLO, 'a', 'next')).toBe('a');
    expect(moveActive(SOLO, 'a', 'previous')).toBe('a');
  });

  test('moves to the next item', () => {
    expect(moveActive(ITEMS, 'a', 'next')).toBe('b');
    expect(moveActive(ITEMS, 'b', 'next')).toBe('c');
  });

  test('moves to the previous item', () => {
    expect(moveActive(ITEMS, 'c', 'previous')).toBe('b');
    expect(moveActive(ITEMS, 'b', 'previous')).toBe('a');
  });

  test('wraps from the last item to the first on next', () => {
    expect(moveActive(ITEMS, 'c', 'next')).toBe('a');
  });

  test('wraps from the first item to the last on previous', () => {
    expect(moveActive(ITEMS, 'a', 'previous')).toBe('c');
  });

  test('resyncs a stale/missing activeId before moving, instead of throwing off the index math', () => {
    // Not in ITEMS: resolves to the first item ('a') before computing the move.
    expect(moveActive(ITEMS, 'ghost', 'next')).toBe('b');
    expect(moveActive(ITEMS, 'ghost', 'previous')).toBe('c');
    expect(moveActive(ITEMS, null, 'next')).toBe('b');
  });
});
