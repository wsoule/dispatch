import { describe, expect, test } from 'bun:test';

import type { InboxEntryDraft, InboxState } from './inbox';
import {
  addEntries,
  loadInbox,
  markAllRead,
  saveInbox,
  unreadCount,
} from './inbox';

// A minimal draft fixture — only the fields addEntries actually consumes.
function draft(
  ts: string,
  title: string,
  body = `body for ${title}`
): InboxEntryDraft {
  return { ts, title, body, target: { kind: 'queue' } };
}

// A stub `Storage` that's just an in-memory map — narrow enough to satisfy
// `Pick<Storage, 'getItem' | 'setItem'>` without a real `localStorage`.
function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    raw: map,
  };
}

describe('addEntries', () => {
  test('adds a single entry as unread with an id derived from ts+title', () => {
    const next = addEntries({ entries: [] }, [
      draft('2026-01-01T00:00:00.000Z', 'Merged'),
    ]);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({
      id: '2026-01-01T00:00:00.000Z:Merged',
      ts: '2026-01-01T00:00:00.000Z',
      title: 'Merged',
      read: false,
    });
  });

  test('new entries land newest-first, ahead of existing entries', () => {
    const state: InboxState = {
      entries: [
        {
          id: 'old',
          ts: 't0',
          title: 'Old',
          body: '',
          target: { kind: 'queue' },
          read: true,
        },
      ],
    };
    const next = addEntries(state, [draft('t1', 'New')]);
    expect(next.entries.map((e) => e.title)).toEqual(['New', 'Old']);
  });

  test('multiple adds in one batch keep the batch itself newest-first', () => {
    const next = addEntries({ entries: [] }, [
      draft('t1', 'First'),
      draft('t2', 'Second'),
    ]);
    expect(next.entries.map((e) => e.title)).toEqual(['Second', 'First']);
  });

  test('a ts+title collision against an existing entry gets a numeric suffix', () => {
    const state: InboxState = {
      entries: [
        {
          id: '2026-01-01T00:00:00.000Z:Merged',
          ts: '2026-01-01T00:00:00.000Z',
          title: 'Merged',
          body: 'first',
          target: { kind: 'queue' },
          read: true,
        },
      ],
    };
    const next = addEntries(state, [
      draft('2026-01-01T00:00:00.000Z', 'Merged', 'second'),
    ]);
    expect(next.entries[0].id).toBe('2026-01-01T00:00:00.000Z:Merged:2');
    expect(next.entries[1].id).toBe('2026-01-01T00:00:00.000Z:Merged');
  });

  test('a ts+title collision within the same batch also gets distinct ids', () => {
    const next = addEntries({ entries: [] }, [
      draft('same-ts', 'Merged', 'run a'),
      draft('same-ts', 'Merged', 'run b'),
    ]);
    const ids = next.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('caps at 100 entries, dropping the oldest', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `old-${i}`,
      ts: `t${i}`,
      title: `Old ${i}`,
      body: '',
      target: { kind: 'queue' as const },
      read: true,
    }));
    const next = addEntries({ entries }, [draft('t100', 'Newest')]);
    expect(next.entries).toHaveLength(100);
    expect(next.entries[0].title).toBe('Newest');
    expect(next.entries.some((e) => e.id === 'old-99')).toBe(false);
  });

  test('an empty adds list returns the same state reference', () => {
    const state: InboxState = { entries: [] };
    expect(addEntries(state, [])).toBe(state);
  });
});

describe('unreadCount', () => {
  test('counts only unread entries', () => {
    const state: InboxState = {
      entries: [
        {
          id: 'a',
          ts: 't',
          title: 'A',
          body: '',
          target: { kind: 'queue' },
          read: false,
        },
        {
          id: 'b',
          ts: 't',
          title: 'B',
          body: '',
          target: { kind: 'queue' },
          read: true,
        },
        {
          id: 'c',
          ts: 't',
          title: 'C',
          body: '',
          target: { kind: 'queue' },
          read: false,
        },
      ],
    };
    expect(unreadCount(state)).toBe(2);
  });

  test('an empty inbox has zero unread', () => {
    expect(unreadCount({ entries: [] })).toBe(0);
  });
});

describe('markAllRead', () => {
  test('flips every unread entry to read', () => {
    const state: InboxState = {
      entries: [
        {
          id: 'a',
          ts: 't',
          title: 'A',
          body: '',
          target: { kind: 'queue' },
          read: false,
        },
        {
          id: 'b',
          ts: 't',
          title: 'B',
          body: '',
          target: { kind: 'queue' },
          read: false,
        },
      ],
    };
    const next = markAllRead(state);
    expect(next.entries.every((e) => e.read)).toBe(true);
  });

  test('returns the same state reference when everything is already read', () => {
    const state: InboxState = {
      entries: [
        {
          id: 'a',
          ts: 't',
          title: 'A',
          body: '',
          target: { kind: 'queue' },
          read: true,
        },
      ],
    };
    expect(markAllRead(state)).toBe(state);
  });
});

describe('loadInbox / saveInbox', () => {
  test('round-trips a saved state through a stub storage', () => {
    const storage = stubStorage();
    const state = addEntries({ entries: [] }, [draft('t1', 'Merged')]);
    saveInbox('/repo/a', state, storage);
    const loaded = loadInbox('/repo/a', storage);
    expect(loaded).toEqual(state);
  });

  test('a missing key loads as an empty inbox', () => {
    const storage = stubStorage();
    expect(loadInbox('/repo/missing', storage)).toEqual({ entries: [] });
  });

  test('corrupt JSON loads as an empty inbox rather than throwing', () => {
    const storage = stubStorage({ 'dispatch:inbox:/repo/a': '{not json' });
    expect(loadInbox('/repo/a', storage)).toEqual({ entries: [] });
  });

  test('a well-formed-but-wrong-shaped value loads as an empty inbox', () => {
    const storage = stubStorage({
      'dispatch:inbox:/repo/a': JSON.stringify({ notEntries: [] }),
    });
    expect(loadInbox('/repo/a', storage)).toEqual({ entries: [] });
  });

  test('two project roots keep independent storage keys', () => {
    const storage = stubStorage();
    saveInbox(
      '/repo/a',
      addEntries({ entries: [] }, [draft('t1', 'A')]),
      storage
    );
    saveInbox(
      '/repo/b',
      addEntries({ entries: [] }, [draft('t1', 'B')]),
      storage
    );
    expect(loadInbox('/repo/a', storage).entries[0].title).toBe('A');
    expect(loadInbox('/repo/b', storage).entries[0].title).toBe('B');
  });

  test('a storage that throws (quota exceeded, Safari private mode) is swallowed, not propagated', () => {
    const throwingStorage: Pick<Storage, 'setItem'> = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      expect(() =>
        saveInbox('/repo/a', { entries: [] }, throwingStorage)
      ).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warned).toBe(true);
  });
});
