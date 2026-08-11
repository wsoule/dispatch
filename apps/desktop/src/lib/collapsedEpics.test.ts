import { describe, expect, test } from 'bun:test';

import {
  COLLAPSED_EPICS_STORAGE_KEY,
  parseCollapsedEpics,
  serializeCollapsedEpics,
  toggleCollapsedEpic,
} from './collapsedEpics';

describe('parseCollapsedEpics', () => {
  test('an unset value means nothing is collapsed', () => {
    expect(parseCollapsedEpics(null)).toEqual(new Set());
    expect(parseCollapsedEpics('')).toEqual(new Set());
  });

  test('round-trips a stored set', () => {
    const keys = new Set(['e-1', 'e-2']);
    expect(parseCollapsedEpics(serializeCollapsedEpics(keys))).toEqual(keys);
  });

  // Storage is user-visible and hand-editable; a bad value must not take the board down with it.
  test.each(['{', 'null', '"e-1"', '{"e-1":true}', '3'])(
    'junk (%p) reads as nothing collapsed rather than throwing',
    (stored) => {
      expect(parseCollapsedEpics(stored)).toEqual(new Set());
    }
  );

  test('non-string entries are dropped, the rest survive', () => {
    expect(parseCollapsedEpics('["e-1", 7, null, "e-2"]')).toEqual(
      new Set(['e-1', 'e-2'])
    );
  });
});

describe('serializeCollapsedEpics', () => {
  test('is stable regardless of insertion order', () => {
    expect(serializeCollapsedEpics(new Set(['e-2', 'e-1']))).toBe(
      serializeCollapsedEpics(new Set(['e-1', 'e-2']))
    );
  });
});

describe('toggleCollapsedEpic', () => {
  test('collapses a lane that was expanded, and back again', () => {
    const collapsed = toggleCollapsedEpic(new Set(), 'e-1');
    expect(collapsed.has('e-1')).toBe(true);
    expect(toggleCollapsedEpic(collapsed, 'e-1').has('e-1')).toBe(false);
  });

  test('leaves the other lanes alone', () => {
    expect(toggleCollapsedEpic(new Set(['e-1']), 'e-2')).toEqual(
      new Set(['e-1', 'e-2'])
    );
  });

  test('returns a new set rather than mutating state in place', () => {
    const before = new Set(['e-1']);
    toggleCollapsedEpic(before, 'e-2');
    expect(before).toEqual(new Set(['e-1']));
  });
});

describe('storage key', () => {
  // Session-scoped by design — see the module comment. The key living in its own namespace keeps
  // it from colliding with the view-mode preference, which is deliberately long-lived.
  test('is namespaced to dispatch', () => {
    expect(COLLAPSED_EPICS_STORAGE_KEY).toStartWith('dispatch:');
  });
});
