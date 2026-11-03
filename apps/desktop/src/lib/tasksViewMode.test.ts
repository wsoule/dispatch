import { describe, expect, test } from 'bun:test';

import { isRetiredLayout, TASKS_VIEW_TABS } from './tasksViewMode';

describe('view tabs', () => {
  test('the header offers Board and List in that order', () => {
    expect(TASKS_VIEW_TABS.map((t) => t.id)).toEqual(['board', 'list']);
    expect(TASKS_VIEW_TABS.map((t) => t.label)).toEqual(['Board', 'List']);
  });
});

describe('isRetiredLayout', () => {
  // The milestone layouts (Branches, then Milestones, then the Graph mode) are
  // a page of their own now; the list is the layout that still groups by
  // milestone, so a stored payload naming one of them reads as the list
  // (lib/tasksPrefs.ts).
  test.each(['branches', 'milestones', 'graph'])(
    'a stored %s layout is retired',
    (stored) => {
      expect(isRetiredLayout(stored)).toBe(true);
    }
  );

  test('the live layouts, an unset value and junk are not retired', () => {
    for (const tab of TASKS_VIEW_TABS) {
      expect(isRetiredLayout(tab.id)).toBe(false);
    }
    expect(isRetiredLayout(null)).toBe(false);
    expect(isRetiredLayout(undefined)).toBe(false);
    expect(isRetiredLayout('lanes')).toBe(false);
    expect(isRetiredLayout(42)).toBe(false);
  });
});
