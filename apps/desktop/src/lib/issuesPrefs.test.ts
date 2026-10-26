import { beforeEach, describe, expect, test } from 'bun:test';

import {
  ISSUES_DISPLAY,
  readIssuesDisplay,
  readIssuesFilters,
  writeIssuesDisplay,
  writeIssuesFilters,
} from './issuesPrefs';
import { EMPTY_TASK_FILTER_SET, type TaskFilterSet } from './taskFilters';

beforeEach(() => {
  window.localStorage.clear();
});

describe('the Issues list display', () => {
  test('defaults to the list grouped by milestone', () => {
    const prefs = readIssuesDisplay();
    expect(prefs).toBe(ISSUES_DISPLAY);
    expect(prefs.grouping).toBe('milestone');
  });

  test('round-trips a change through storage', () => {
    writeIssuesDisplay({ ...ISSUES_DISPLAY, grouping: 'assignee' });
    expect(readIssuesDisplay().grouping).toBe('assignee');
  });

  test('ignores Classic’s board display', () => {
    window.localStorage.setItem(
      'dispatch:tasks-display-v1',
      JSON.stringify({ grouping: 'status' })
    );
    expect(readIssuesDisplay().grouping).toBe('milestone');
  });

  // The keys keep their Two views names on purpose: renaming them would drop
  // every person's remembered grouping on upgrade.
  test('reads and writes the Two views key', () => {
    writeIssuesDisplay({ ...ISSUES_DISPLAY, grouping: 'epic' });
    expect(
      window.localStorage.getItem('dispatch:two-views-tasks-display-v1')
    ).toContain('"epic"');
  });

  // The Graph mode saved its layout as `milestones` (the milestone map); the
  // graph is a sidebar destination now, so a window that last had it open
  // comes back on the list, the layout that still groups by milestone.
  test.each(['milestones', 'graph'])(
    'a display saved in the retired %s layout reads as the list',
    (layout) => {
      window.localStorage.setItem(
        'dispatch:two-views-tasks-display-v1',
        JSON.stringify({ version: 2, layout, grouping: 'milestone' })
      );
      const prefs = readIssuesDisplay();
      expect(prefs.layout).toBe('list');
      expect(prefs.grouping).toBe('milestone');
    }
  );
});

describe('the Issues list filters', () => {
  test('default to none, and round-trip through the Two views key', () => {
    expect(readIssuesFilters()).toEqual(EMPTY_TASK_FILTER_SET);
    const filters: TaskFilterSet = {
      clauses: [{ facet: 'status', op: 'is', values: ['ready'] }],
      join: 'and',
    };
    writeIssuesFilters(filters);
    expect(
      window.localStorage.getItem('dispatch:two-views-tasks-filters-v1')
    ).not.toBeNull();
    expect(readIssuesFilters()).toEqual(filters);
  });
});
