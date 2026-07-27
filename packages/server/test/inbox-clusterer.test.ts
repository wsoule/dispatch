import { describe, expect, test } from 'bun:test';

import type { InboxItem } from '../src/inbox';
import type { InboxClusterGroup } from '../src/inboxClusterer';
import { sanitize } from '../src/inboxClusterer';

function item(id: string, text = id): InboxItem {
  return {
    id,
    kind: 'note',
    text,
    done: false,
    linkedTaskId: null,
    createdByRunId: null,
    created: '',
  };
}

const items = [item('a'), item('b'), item('c'), item('d')];

function group(over: Partial<InboxClusterGroup> = {}): InboxClusterGroup {
  return {
    epicTitle: 'Worktree hygiene',
    reason: 'all about worktrees',
    itemIds: ['a', 'b'],
    ...over,
  };
}

describe('sanitize', () => {
  test('keeps a well-formed group', () => {
    expect(sanitize([group()], items)).toHaveLength(1);
  });

  // A model asked for ids will occasionally invent one. A group naming a phantom item would
  // render a count the user cannot reconcile with what they see.
  test('drops ids that do not exist', () => {
    const out = sanitize([group({ itemIds: ['a', 'b', 'nope'] })], items);
    expect(out[0]?.itemIds).toEqual(['a', 'b']);
  });

  test('a group left with fewer than two real items is dropped entirely', () => {
    expect(sanitize([group({ itemIds: ['a', 'ghost'] })], items)).toEqual([]);
  });

  // Overlapping groups would let one click add an item to two epics.
  test('an item can only be claimed by the first group that wants it', () => {
    const out = sanitize(
      [group({ itemIds: ['a', 'b'] }), group({ itemIds: ['b', 'c'] })],
      items
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.itemIds).toEqual(['a', 'b']);
  });

  test('a repeated id inside one group is deduped, not counted twice', () => {
    const out = sanitize([group({ itemIds: ['a', 'a', 'b'] })], items);
    expect(out[0]?.itemIds).toEqual(['a', 'b']);
  });

  test('a group with no usable title is dropped', () => {
    expect(sanitize([group({ epicTitle: '   ' })], items)).toEqual([]);
  });

  test('a missing reason degrades to empty rather than dropping the group', () => {
    const out = sanitize(
      [{ epicTitle: 'Fine', itemIds: ['a', 'b'] } as InboxClusterGroup],
      items
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('');
  });

  test('no groups in, no groups out', () => {
    expect(sanitize([], items)).toEqual([]);
  });

  test('titles and reasons are trimmed', () => {
    const out = sanitize(
      [group({ epicTitle: '  Padded  ', reason: '  why  ' })],
      items
    );
    expect(out[0]?.epicTitle).toBe('Padded');
    expect(out[0]?.reason).toBe('why');
  });
});
