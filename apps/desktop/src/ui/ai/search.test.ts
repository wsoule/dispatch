import { describe, expect, test } from 'bun:test';

import type { SearchGroup } from './search';
import { filterGroups } from './search';

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
