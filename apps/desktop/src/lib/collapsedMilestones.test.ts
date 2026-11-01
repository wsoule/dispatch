import { describe, expect, test } from 'bun:test';

import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  COLLAPSED_LANES_STORAGE_KEY,
  parseCollapsedGroups,
  readCollapsedGroups,
  serializeCollapsedGroups,
  toggleCollapsedGroup,
  TOGGLED_MILESTONES_STORAGE_KEY,
  writeCollapsedGroups,
} from './collapsedMilestones';

describe('parseCollapsedGroups', () => {
  test('an unset value means nothing is collapsed', () => {
    expect(parseCollapsedGroups(null)).toEqual(new Set());
    expect(parseCollapsedGroups('')).toEqual(new Set());
  });

  test('round-trips a stored set', () => {
    const keys = new Set(['e-1', 'e-2']);
    expect(parseCollapsedGroups(serializeCollapsedGroups(keys))).toEqual(keys);
  });

  // Storage is user-visible and hand-editable; a bad value must not take the board down with it.
  test.each(['{', 'null', '"e-1"', '{"e-1":true}', '3'])(
    'junk (%p) reads as nothing collapsed rather than throwing',
    (stored) => {
      expect(parseCollapsedGroups(stored)).toEqual(new Set());
    }
  );

  test('non-string entries are dropped, the rest survive', () => {
    expect(parseCollapsedGroups('["e-1", 7, null, "e-2"]')).toEqual(
      new Set(['e-1', 'e-2'])
    );
  });
});

describe('serializeCollapsedGroups', () => {
  test('is stable regardless of insertion order', () => {
    expect(serializeCollapsedGroups(new Set(['e-2', 'e-1']))).toBe(
      serializeCollapsedGroups(new Set(['e-1', 'e-2']))
    );
  });
});

describe('toggleCollapsedGroup', () => {
  test('collapses a lane that was expanded, and back again', () => {
    const collapsed = toggleCollapsedGroup(new Set(), 'e-1');
    expect(collapsed.has('e-1')).toBe(true);
    expect(toggleCollapsedGroup(collapsed, 'e-1').has('e-1')).toBe(false);
  });

  test('leaves the other lanes alone', () => {
    expect(toggleCollapsedGroup(new Set(['e-1']), 'e-2')).toEqual(
      new Set(['e-1', 'e-2'])
    );
  });

  test('returns a new set rather than mutating state in place', () => {
    const before = new Set(['e-1']);
    toggleCollapsedGroup(before, 'e-2');
    expect(before).toEqual(new Set(['e-1']));
  });
});

describe('storage key', () => {
  // Session-scoped by design — see the module comment. The key living in its own namespace keeps
  // it from colliding with the view-mode preference, which is deliberately long-lived.
  test('is namespaced to dispatch', () => {
    expect(COLLAPSED_LANES_STORAGE_KEY).toStartWith('dispatch:');
    expect(COLLAPSED_GROUPS_STORAGE_KEY).toBe('dispatch:list-collapsed-groups');
    // The Milestones page stores "flipped from default", so it must not share the list's key.
    expect(TOGGLED_MILESTONES_STORAGE_KEY).not.toBe(
      COLLAPSED_GROUPS_STORAGE_KEY
    );
    expect(TOGGLED_MILESTONES_STORAGE_KEY).toStartWith('dispatch:');
  });
});

// The list's groups are keyed by kind and id (`status:ready`, `milestone:e-1`), not by milestone alone;
// the helpers take any string.
describe('collapsed groups', () => {
  test('any group key round-trips', () => {
    const keys = toggleCollapsedGroup(
      new Set(['status:ready']),
      'milestone:e-1'
    );
    expect(parseCollapsedGroups(serializeCollapsedGroups(keys))).toEqual(
      new Set(['milestone:e-1', 'status:ready'])
    );
  });

  test('read/write go through sessionStorage and tolerate an empty store', () => {
    window.sessionStorage.removeItem(COLLAPSED_GROUPS_STORAGE_KEY);
    expect(readCollapsedGroups(COLLAPSED_GROUPS_STORAGE_KEY)).toEqual(
      new Set()
    );
    writeCollapsedGroups(
      COLLAPSED_GROUPS_STORAGE_KEY,
      new Set(['milestone:e-2'])
    );
    expect(readCollapsedGroups(COLLAPSED_GROUPS_STORAGE_KEY)).toEqual(
      new Set(['milestone:e-2'])
    );
    window.sessionStorage.removeItem(COLLAPSED_GROUPS_STORAGE_KEY);
  });
});
