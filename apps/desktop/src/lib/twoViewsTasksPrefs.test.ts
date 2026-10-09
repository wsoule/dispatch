import { beforeEach, describe, expect, test } from 'bun:test';

import {
  layoutForMode,
  modeForLayout,
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
});

describe('layouts and modes', () => {
  test.each([
    ['list', 'list'],
    ['board', 'board'],
    ['graph', 'milestones'],
  ] as const)('%p saves as %p', (mode, layout) => {
    expect(layoutForMode(mode)).toBe(layout);
    expect(modeForLayout(layout)).toBe(mode);
  });

  test('a Branches view opens the graph', () => {
    expect(modeForLayout('branches')).toBe('graph');
  });
});
