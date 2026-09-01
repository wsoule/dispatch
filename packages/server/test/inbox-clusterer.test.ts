import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InboxStore } from '../src/inbox';
import type { InboxItem } from '../src/inbox';
import type { InboxClusterGroup } from '../src/inboxClusterer';
import {
  filterGroupsToLocalItems,
  InboxClusterSnapshotStore,
  sanitize,
} from '../src/inboxClusterer';

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

// Regression: clusterInbox (api.ts) calls cluster() with listAll() — every actor's items — so
// the model can group work described across teammates. But display and convert only ever
// resolve ids against list(), the local actor's own file. Without this filter, a group spanning
// two actors' files would overstate the count BrainDumpView renders, seed selection with an id
// the local UI can't resolve, and fail convert outright — and a teammate's private capture text
// would enter a local model call via the returned itemIds without ever being displayed.
describe('filterGroupsToLocalItems', () => {
  test("a cluster response contains no item id belonging to another actor's file", () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-inbox-cluster-'));
    const mine = new InboxStore(root, 'wyat');
    const theirs = new InboxStore(root, 'alex');
    const [a, b] = mine.add({ text: 'fix the parser\nadd the linter' });
    const [c] = theirs.add({ text: 'fix the parser too' });

    // As if the model grouped one of my items with a teammate's, plus a
    // group made entirely of my own items.
    const groups: InboxClusterGroup[] = [
      {
        epicTitle: 'Parser work',
        reason: 'same underlying bug',
        itemIds: [a.id, c.id],
      },
      {
        epicTitle: 'Mine only',
        reason: 'both about tooling',
        itemIds: [a.id, b.id],
      },
    ];

    const localIds = new Set(mine.list().map((i) => i.id));
    const out = filterGroupsToLocalItems(groups, localIds);

    for (const g of out) {
      for (const id of g.itemIds) {
        expect(id).not.toBe(c.id);
      }
    }
    // The cross-actor group drops below the two-item floor once the
    // teammate's id is filtered out, so only the local-only group survives.
    expect(out).toHaveLength(1);
    expect(out[0]?.itemIds.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('InboxClusterSnapshotStore', () => {
  test('round-trips a pass and overwrites on the next one', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-clusters-'));
    const store = new InboxClusterSnapshotStore(root);
    expect(store.load()).toBeNull();

    const first = {
      groups: [group()],
      itemIds: ['a', 'b', 'c'],
      updatedAt: '2026-08-22T00:00:00.000Z',
    };
    store.save(first);
    expect(store.load()).toEqual(first);

    const second = {
      groups: [],
      itemIds: ['d'],
      updatedAt: '2026-08-22T01:00:00.000Z',
    };
    store.save(second);
    // The last answer is a cache, not a log — one snapshot, always the latest.
    expect(store.load()).toEqual(second);
  });

  test('a corrupt or mis-shaped cache reads as null, never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-clusters-'));
    const file = join(root, '.dispatch', 'inbox-clusters.json');
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(file, 'not json');
    expect(new InboxClusterSnapshotStore(root).load()).toBeNull();
    writeFileSync(file, JSON.stringify({ groups: 'nope' }));
    expect(new InboxClusterSnapshotStore(root).load()).toBeNull();
  });
});
