import { describe, expect, test } from 'bun:test';

import { parseViewMode, VIEW_MODE_STORAGE_KEY } from './tasksViewMode';

describe('parseViewMode', () => {
  test('an unset preference opens on the board', () => {
    expect(parseViewMode(null)).toBe('board');
  });

  test.each(['board', 'list', 'milestones'] as const)(
    'a stored %s is honoured',
    (mode) => {
      expect(parseViewMode(mode)).toBe(mode);
    }
  );

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
