import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_BOARD_COLUMN_PREFS,
  EMPTY_TASK_FILTERS,
  hasActiveFilters,
  matchesTaskFilters,
  parseBoardColumnPrefs,
  parseHiddenListColumns,
  parseTaskFilters,
  toggleFilterValue,
  visibleBoardStatuses,
} from './tasksPrefs';

function makeTask(status: string, priority = 'none'): TaskDoc {
  return {
    meta: {
      id: 't-1',
      title: 'T',
      status,
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: priority as TaskDoc['meta']['priority'],
      assignee: 'none',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
    },
    body: '',
  };
}

describe('parseTaskFilters', () => {
  it('defaults on null, garbage, and wrong shapes', () => {
    expect(parseTaskFilters(null)).toEqual(EMPTY_TASK_FILTERS);
    expect(parseTaskFilters('not json')).toEqual(EMPTY_TASK_FILTERS);
    expect(parseTaskFilters('"a string"')).toEqual(EMPTY_TASK_FILTERS);
    expect(parseTaskFilters('{"statuses": [1, "ready"]}')).toEqual({
      statuses: ['ready'],
      priorities: [],
    });
  });
});

describe('parseBoardColumnPrefs', () => {
  it('defaults hideEmpty to true', () => {
    expect(parseBoardColumnPrefs(null)).toEqual(DEFAULT_BOARD_COLUMN_PREFS);
    expect(parseBoardColumnPrefs('{"hidden": ["dropped"]}')).toEqual({
      hideEmpty: true,
      hidden: ['dropped'],
      groupByEpic: false,
    });
    expect(parseBoardColumnPrefs('{"hideEmpty": false}')).toEqual({
      hideEmpty: false,
      hidden: [],
      groupByEpic: false,
    });
  });
});

describe('parseHiddenListColumns', () => {
  it('parses a string array and defaults otherwise', () => {
    expect(parseHiddenListColumns('["tags"]')).toEqual(['tags']);
    expect(parseHiddenListColumns('oops')).toEqual([]);
  });
});

describe('toggleFilterValue / hasActiveFilters', () => {
  it('toggles membership', () => {
    expect(toggleFilterValue([], 'ready')).toEqual(['ready']);
    expect(toggleFilterValue(['ready'], 'ready')).toEqual([]);
  });

  it('reports active state', () => {
    expect(hasActiveFilters(EMPTY_TASK_FILTERS)).toBe(false);
    expect(hasActiveFilters({ statuses: ['ready'], priorities: [] })).toBe(
      true
    );
  });
});

describe('matchesTaskFilters', () => {
  it('empty filters pass everything', () => {
    expect(matchesTaskFilters(makeTask('ready'), EMPTY_TASK_FILTERS)).toBe(
      true
    );
  });

  it('unions within a group, intersects across groups', () => {
    const filters = { statuses: ['ready', 'working'], priorities: ['high'] };
    expect(matchesTaskFilters(makeTask('ready', 'high'), filters)).toBe(true);
    expect(matchesTaskFilters(makeTask('working', 'high'), filters)).toBe(true);
    expect(matchesTaskFilters(makeTask('ready', 'low'), filters)).toBe(false);
    expect(matchesTaskFilters(makeTask('review', 'high'), filters)).toBe(false);
  });
});

describe('visibleBoardStatuses', () => {
  const statuses = ['draft', 'ready', 'working', 'landed'];
  const counts = new Map([
    ['draft', 0],
    ['ready', 5],
    ['working', 1],
    ['landed', 0],
  ]);

  it('hides empty columns when hideEmpty is on', () => {
    expect(
      visibleBoardStatuses(
        statuses,
        { hideEmpty: true, hidden: [], groupByEpic: false },
        counts
      )
    ).toEqual(['ready', 'working']);
  });

  it('keeps empty columns when hideEmpty is off', () => {
    expect(
      visibleBoardStatuses(
        statuses,
        { hideEmpty: false, hidden: [], groupByEpic: false },
        counts
      )
    ).toEqual(statuses);
  });

  it('explicit hides win regardless of count', () => {
    expect(
      visibleBoardStatuses(
        statuses,
        { hideEmpty: false, hidden: ['ready'], groupByEpic: false },
        counts
      )
    ).toEqual(['draft', 'working', 'landed']);
  });
});
