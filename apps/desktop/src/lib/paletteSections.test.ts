import { describe, expect, test } from 'bun:test';

import type { PaletteEntry, PaletteSection } from './paletteEntries';
import {
  groupPaletteSections,
  PALETTE_RECENT_LIMIT,
  PALETTE_SECTION_CAPS,
  rememberRecent,
} from './paletteSections';

function entry(id: string, section: PaletteSection, label = id): PaletteEntry {
  return { id, label, kind: section, section, run: () => {} };
}

function many(section: PaletteSection, count: number): PaletteEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`${section}-${i}`, section)
  );
}

describe('groupPaletteSections', () => {
  test('an empty query lists sections in the fixed order, skipping empty ones', () => {
    const ranked = [
      entry('go-board', 'navigation'),
      entry('action-new-task', 'actions'),
      entry('task-1', 'tasks'),
    ];
    const slices = groupPaletteSections(ranked, { query: '' });
    expect(slices.map((s) => s.section)).toEqual([
      'tasks',
      'navigation',
      'actions',
    ]);
    expect(slices.map((s) => s.heading)).toEqual([
      'Tasks',
      'Navigation',
      'Actions',
    ]);
  });

  test('lists the Docs section after Tasks while browsing', () => {
    const ranked = [entry('d1', 'docs', 'Auth spec'), entry('t1', 'tasks')];
    expect(
      groupPaletteSections(ranked, { query: '' }).map((s) => s.heading)
    ).toEqual(['Tasks', 'Docs']);
  });

  test('caps each section: inbox 3, tasks 8, docs 6, views 4, navigation and actions unbounded', () => {
    const ranked = [
      ...many('inbox', 5),
      ...many('tasks', 12),
      ...many('docs', 9),
      ...many('views', 6),
      ...many('navigation', 20),
      ...many('actions', 15),
    ];
    const slices = groupPaletteSections(ranked, { query: '' });
    const sizes = Object.fromEntries(
      slices.map((s) => [s.section, s.items.length])
    );
    expect(sizes).toEqual({
      inbox: 3,
      tasks: 8,
      docs: 6,
      views: 4,
      navigation: 20,
      actions: 15,
    });
    expect(PALETTE_SECTION_CAPS.navigation).toBe(Number.POSITIVE_INFINITY);
  });

  test('keeps the ranked order inside a section', () => {
    const ranked = [
      entry('task-b', 'tasks'),
      entry('task-a', 'tasks'),
      entry('task-c', 'tasks'),
    ];
    const [tasks] = groupPaletteSections(ranked, { query: 'ta' });
    expect(tasks?.items.map((i) => i.id)).toEqual([
      'task-b',
      'task-a',
      'task-c',
    ]);
  });

  test('with an empty query, recently-run rows lead their section, most recent first', () => {
    const ranked = [
      entry('task-a', 'tasks'),
      entry('task-b', 'tasks'),
      entry('task-c', 'tasks'),
      entry('go-board', 'navigation'),
    ];
    const slices = groupPaletteSections(ranked, {
      query: '',
      recentIds: ['task-c', 'go-board', 'task-a', 'task-ghost'],
    });
    expect(slices[0]?.items.map((i) => i.id)).toEqual([
      'task-c',
      'task-a',
      'task-b',
    ]);
    // A recent id from another section never leaks in.
    expect(slices[1]?.items.map((i) => i.id)).toEqual(['go-board']);
  });

  test('a recent row still counts against its section cap', () => {
    const ranked = many('tasks', 10);
    const [tasks] = groupPaletteSections(ranked, {
      query: '',
      recentIds: ['tasks-9'],
    });
    expect(tasks?.items).toHaveLength(8);
    expect(tasks?.items[0]?.id).toBe('tasks-9');
    expect(tasks?.items.some((i) => i.id === 'tasks-8')).toBe(false);
  });

  test('with a query, recency is ignored and sections follow the best-ranked row', () => {
    // `ranked` is the fuzzy order: the best hit is an action, then a task, then a nav row.
    const ranked = [
      entry('action-new-task', 'actions', 'New task'),
      entry('task-1', 'tasks', 'New tasks list'),
      entry('go-tasks', 'navigation', 'Go to Tasks'),
      entry('task-2', 'tasks', 'Newer task'),
    ];
    const slices = groupPaletteSections(ranked, {
      query: 'new',
      recentIds: ['task-2'],
    });
    expect(slices.map((s) => s.section)).toEqual([
      'actions',
      'tasks',
      'navigation',
    ]);
    expect(slices[1]?.items.map((i) => i.id)).toEqual(['task-1', 'task-2']);
  });

  test('a whitespace-only query counts as empty', () => {
    const ranked = [entry('go-board', 'navigation'), entry('task-1', 'tasks')];
    const slices = groupPaletteSections(ranked, { query: '   ' });
    expect(slices.map((s) => s.section)).toEqual(['tasks', 'navigation']);
  });

  test('returns nothing for no entries', () => {
    expect(groupPaletteSections([], { query: '' })).toEqual([]);
  });
});

describe('rememberRecent', () => {
  test('puts the id first and removes an earlier copy', () => {
    expect(rememberRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(rememberRecent([], 'a')).toEqual(['a']);
  });

  test('trims to the recent limit', () => {
    const full = Array.from({ length: PALETTE_RECENT_LIMIT }, (_, i) => `${i}`);
    const next = rememberRecent(full, 'new');
    expect(next).toHaveLength(PALETTE_RECENT_LIMIT);
    expect(next[0]).toBe('new');
    expect(next.includes(`${PALETTE_RECENT_LIMIT - 1}`)).toBe(false);
  });
});
