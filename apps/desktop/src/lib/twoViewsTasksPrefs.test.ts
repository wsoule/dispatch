import { beforeEach, describe, expect, test } from 'bun:test';

import {
  readTwoViewsDisplay,
  TWO_VIEWS_TASKS_DISPLAY,
  writeTwoViewsDisplay,
} from './twoViewsTasksPrefs';

beforeEach(() => {
  window.localStorage.clear();
});

describe('Two views Tasks display', () => {
  test('defaults to the list grouped by milestone', () => {
    const prefs = readTwoViewsDisplay();
    expect(prefs).toBe(TWO_VIEWS_TASKS_DISPLAY);
    expect(prefs.grouping).toBe('milestone');
  });

  test('round-trips a change through storage', () => {
    writeTwoViewsDisplay({ ...TWO_VIEWS_TASKS_DISPLAY, grouping: 'assignee' });
    expect(readTwoViewsDisplay().grouping).toBe('assignee');
  });

  test('ignores Classic’s board display', () => {
    window.localStorage.setItem(
      'dispatch:tasks-display-v1',
      JSON.stringify({ grouping: 'status' })
    );
    expect(readTwoViewsDisplay().grouping).toBe('milestone');
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
      const prefs = readTwoViewsDisplay();
      expect(prefs.layout).toBe('list');
      expect(prefs.grouping).toBe('milestone');
    }
  );
});
