import { describe, expect, test } from 'bun:test';

import {
  addSavedView,
  type FavoriteRef,
  isFavorite,
  loadFavorites,
  loadSavedViews,
  newViewId,
  removeSavedView,
  renameSavedView,
  type SavedView,
  saveFavorites,
  saveSavedViews,
  toggleFavorite,
  viewMatches,
} from './savedViews';
import { EMPTY_TASK_FILTER_SET, type TaskFilterSet } from './taskFilters';
import { DEFAULT_TASKS_DISPLAY, type TasksDisplayPrefs } from './tasksPrefs';

// A stand-in for localStorage: the two methods the module uses, backed by a Map.
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const FILTERS: TaskFilterSet = {
  clauses: [{ facet: 'status', op: 'is', values: ['working'] }],
  join: 'and',
};

const DISPLAY: TasksDisplayPrefs = {
  ...DEFAULT_TASKS_DISPLAY,
  layout: 'list',
  properties: new Set(['id', 'status', 'labels']),
};

function view(id: string, overrides: Partial<SavedView> = {}): SavedView {
  return {
    id,
    name: `View ${id}`,
    filters: FILTERS,
    display: DISPLAY,
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('loadSavedViews / saveSavedViews', () => {
  test('round-trips through storage under the root key', () => {
    const storage = memoryStorage();
    saveSavedViews('/a', [view('v-1')], storage);
    expect([...storage.map.keys()]).toEqual(['dispatch:saved-views:/a']);
    expect(loadSavedViews('/a', storage)).toEqual([view('v-1')]);
  });

  test('writes properties as a sorted array so the payload is stable', () => {
    const storage = memoryStorage();
    saveSavedViews(
      '/a',
      [
        view('v-1', {
          display: { ...DISPLAY, properties: new Set(['status', 'id']) },
        }),
      ],
      storage
    );
    const stored = JSON.parse(
      storage.map.get('dispatch:saved-views:/a') ?? ''
    ) as { display: { properties: string[] } }[];
    expect(stored[0]?.display.properties).toEqual(['id', 'status']);
  });

  test('two roots do not see each other', () => {
    const storage = memoryStorage();
    saveSavedViews('/a', [view('v-1')], storage);
    saveSavedViews('/b', [view('v-2')], storage);
    expect(loadSavedViews('/a', storage).map((v) => v.id)).toEqual(['v-1']);
    expect(loadSavedViews('/b', storage).map((v) => v.id)).toEqual(['v-2']);
    expect(loadSavedViews('/c', storage)).toEqual([]);
  });

  test('bad JSON, a non-array and entries without id/name land on an empty list', () => {
    const storage = memoryStorage();
    storage.setItem('dispatch:saved-views:/a', '{not json');
    expect(loadSavedViews('/a', storage)).toEqual([]);
    storage.setItem('dispatch:saved-views:/a', '{"id": "v-1"}');
    expect(loadSavedViews('/a', storage)).toEqual([]);
    storage.setItem(
      'dispatch:saved-views:/a',
      JSON.stringify([{ id: 'v-1' }, { name: 'x' }, 'v-2', null])
    );
    expect(loadSavedViews('/a', storage)).toEqual([]);
  });

  test('unknown facets and stale display keys land on defaults per field', () => {
    const storage = memoryStorage();
    storage.setItem(
      'dispatch:saved-views:/a',
      JSON.stringify([
        {
          id: 'v-1',
          name: 'Odd',
          filters: {
            clauses: [
              { facet: 'sprint', op: 'is', values: ['1'] },
              { facet: 'priority', op: 'is', values: ['urgent'] },
            ],
            join: 'xor',
          },
          display: { layout: 'lanes', grouping: 'assignee', hidden: ['x'] },
        },
        { id: 'v-2', name: 'Bare' },
      ])
    );
    const [odd, bare] = loadSavedViews('/a', storage);
    expect(odd?.filters).toEqual({
      clauses: [{ facet: 'priority', op: 'is', values: ['urgent'] }],
      join: 'and',
    });
    expect(odd?.display).toEqual({
      ...DEFAULT_TASKS_DISPLAY,
      grouping: 'assignee',
    });
    expect(odd?.createdAt).toBe('');
    expect(bare?.filters).toEqual(EMPTY_TASK_FILTER_SET);
    expect(bare?.display).toEqual(DEFAULT_TASKS_DISPLAY);
  });

  test('a throwing setItem is swallowed', () => {
    const storage = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveSavedViews('/a', [view('v-1')], storage)).not.toThrow();
  });
});

describe('loadFavorites / saveFavorites', () => {
  test('round-trips and drops refs with an unknown kind', () => {
    const storage = memoryStorage();
    saveFavorites(
      '/a',
      [
        { kind: 'view', id: 'v-1' },
        { kind: 'task', id: 't-1' },
      ],
      storage
    );
    expect([...storage.map.keys()]).toEqual(['dispatch:favorites:/a']);
    expect(loadFavorites('/a', storage)).toEqual([
      { kind: 'view', id: 'v-1' },
      { kind: 'task', id: 't-1' },
    ]);
    storage.setItem(
      'dispatch:favorites:/a',
      JSON.stringify([
        { kind: 'milestone', id: 'e-1' },
        { kind: 'task', id: 7 },
        { kind: 'task', id: 't-2' },
      ])
    );
    expect(loadFavorites('/a', storage)).toEqual([{ kind: 'task', id: 't-2' }]);
    storage.setItem('dispatch:favorites:/a', 'nope');
    expect(loadFavorites('/a', storage)).toEqual([]);
    expect(loadFavorites('/b', storage)).toEqual([]);
  });
});

describe('view list helpers', () => {
  test('newViewId is v- plus six hex characters and does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, newViewId));
    for (const id of ids) expect(id).toMatch(/^v-[0-9a-f]{6}$/);
    expect(ids.size).toBe(50);
  });

  test('addSavedView appends and renameSavedView edits without mutating', () => {
    const views = [view('v-1')];
    const added = addSavedView(views, view('v-2'));
    expect(added.map((v) => v.id)).toEqual(['v-1', 'v-2']);
    expect(views).toHaveLength(1);
    const renamed = renameSavedView(added, 'v-2', 'Renamed');
    expect(renamed[1]?.name).toBe('Renamed');
    expect(added[1]?.name).toBe('View v-2');
  });

  test('removeSavedView cascades the favorite and leaves task favorites alone', () => {
    const favorites: FavoriteRef[] = [
      { kind: 'view', id: 'v-1' },
      { kind: 'task', id: 'v-1' },
      { kind: 'view', id: 'v-2' },
    ];
    const next = removeSavedView([view('v-1'), view('v-2')], favorites, 'v-1');
    expect(next.views.map((v) => v.id)).toEqual(['v-2']);
    expect(next.favorites).toEqual([
      { kind: 'task', id: 'v-1' },
      { kind: 'view', id: 'v-2' },
    ]);
  });

  test('toggleFavorite round-trips and isFavorite matches kind and id', () => {
    const ref: FavoriteRef = { kind: 'task', id: 't-1' };
    const on = toggleFavorite([], ref);
    expect(on).toEqual([ref]);
    expect(isFavorite(on, ref)).toBe(true);
    expect(isFavorite(on, { kind: 'view', id: 't-1' })).toBe(false);
    expect(toggleFavorite(on, ref)).toEqual([]);
  });
});

describe('viewMatches', () => {
  test('is true for a view saved from the same filters and prefs', () => {
    expect(viewMatches(view('v-1'), FILTERS, DISPLAY)).toBe(true);
  });

  test('is false after one clause or one property changes', () => {
    const otherFilters: TaskFilterSet = {
      clauses: [{ facet: 'status', op: 'is not', values: ['working'] }],
      join: 'and',
    };
    expect(viewMatches(view('v-1'), otherFilters, DISPLAY)).toBe(false);
    expect(
      viewMatches(view('v-1'), FILTERS, {
        ...DISPLAY,
        properties: new Set(['id', 'status']),
      })
    ).toBe(false);
    expect(
      viewMatches(view('v-1'), FILTERS, { ...DISPLAY, ordering: 'title' })
    ).toBe(false);
  });

  test('is insensitive to properties order and to field assignment order', () => {
    expect(
      viewMatches(view('v-1'), FILTERS, {
        ...DISPLAY,
        properties: new Set(['labels', 'status', 'id']),
      })
    ).toBe(true);
    // Fields assigned in a different order than the parser's: the serializers fix the
    // order, so a future field added out of order still compares equal.
    const shuffledDisplay = {
      dateField: DISPLAY.dateField,
      properties: DISPLAY.properties,
      showEmptyGroups: DISPLAY.showEmptyGroups,
      nestedSubtasks: DISPLAY.nestedSubtasks,
      showSubtasks: DISPLAY.showSubtasks,
      completedByRecency: DISPLAY.completedByRecency,
      orderDir: DISPLAY.orderDir,
      ordering: DISPLAY.ordering,
      subGrouping: DISPLAY.subGrouping,
      grouping: DISPLAY.grouping,
      layout: DISPLAY.layout,
    } satisfies TasksDisplayPrefs;
    const shuffledFilters = {
      join: FILTERS.join,
      clauses: FILTERS.clauses.map((c) => ({
        values: c.values,
        op: c.op,
        facet: c.facet,
      })),
    } satisfies TaskFilterSet;
    expect(viewMatches(view('v-1'), shuffledFilters, shuffledDisplay)).toBe(
      true
    );
  });

  // Removing and re-adding a value in the Filter menu reorders it; the same set of clauses
  // and values in any order is still the saved view.
  test('is insensitive to clause order and value order', () => {
    const saved: TaskFilterSet = {
      clauses: [
        { facet: 'status', op: 'is', values: ['working', 'ready'] },
        { facet: 'priority', op: 'is not', values: ['low'] },
      ],
      join: 'and',
    };
    const reordered: TaskFilterSet = {
      clauses: [
        { facet: 'priority', op: 'is not', values: ['low'] },
        { facet: 'status', op: 'is', values: ['ready', 'working'] },
      ],
      join: 'and',
    };
    const v = view('v-1', { filters: saved });
    expect(viewMatches(v, reordered, DISPLAY)).toBe(true);
    expect(viewMatches(v, { ...reordered, join: 'or' }, DISPLAY)).toBe(false);
    expect(
      viewMatches(
        v,
        {
          ...reordered,
          clauses: [
            reordered.clauses[0],
            { facet: 'status', op: 'is', values: ['ready'] },
          ],
        },
        DISPLAY
      )
    ).toBe(false);
  });
});
