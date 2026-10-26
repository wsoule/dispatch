import { describe, expect, test } from 'bun:test';

import {
  isRetiredLayout,
  parseViewMode,
  TASKS_VIEW_TABS,
  VIEW_MODE_STORAGE_KEY,
} from './tasksViewMode';

describe('parseViewMode', () => {
  test('an unset preference opens on the board', () => {
    expect(parseViewMode(null)).toBe('board');
  });

  test.each(['board', 'list'] as const)('a stored %s is honoured', (mode) => {
    expect(parseViewMode(mode)).toBe(mode);
  });

  test('a stored lanes preference lands on the board that absorbed it', () => {
    expect(parseViewMode('lanes')).toBe('board');
  });

  test('junk falls back to the board rather than throwing', () => {
    expect(parseViewMode('kanban')).toBe('board');
    expect(parseViewMode('')).toBe('board');
  });
});

describe('storage key', () => {
  // The regression this guards: the original key recorded 'board' for every user who ever
  // opened the view, because the persist effect fires on mount rather than on choice. Reading
  // that key back would pin everyone to the old layout while looking like a respected
  // preference — so it must stay abandoned, not migrated from.
  test('is not the pre-lanes key, whose values cannot be trusted', () => {
    expect(VIEW_MODE_STORAGE_KEY).not.toBe('dispatch:tasks-view-mode');
  });
});

describe('view tabs', () => {
  test('the header offers Board and List in that order', () => {
    expect(TASKS_VIEW_TABS.map((t) => t.id)).toEqual(['board', 'list']);
    expect(TASKS_VIEW_TABS.map((t) => t.label)).toEqual(['Board', 'List']);
  });

  // The milestone layouts (Branches, then Milestones, then the Graph mode) are
  // a page of their own now; the list is the layout that still groups by
  // milestone, so a window that last chose one of them opens there.
  test.each(['branches', 'milestones', 'graph'])(
    'a stored %s layout, now retired, lands on the list',
    (stored) => {
      expect(isRetiredLayout(stored)).toBe(true);
      expect(parseViewMode(stored)).toBe('list');
    }
  );

  test('the live layouts are not retired', () => {
    expect(isRetiredLayout('board')).toBe(false);
    expect(isRetiredLayout('list')).toBe(false);
    expect(isRetiredLayout(null)).toBe(false);
  });

  test('every tab id parses back to itself', () => {
    for (const tab of TASKS_VIEW_TABS) {
      expect(parseViewMode(tab.id)).toBe(tab.id);
    }
  });
});
