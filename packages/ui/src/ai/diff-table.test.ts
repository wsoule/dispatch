import { describe, expect, test } from 'bun:test';

import { summarizeDiff } from './diff-table';
import type { DiffTableRow } from './diff-table';

const ROWS: DiffTableRow[] = [
  { id: '1', kind: 'add', cells: { title: { next: 'Ship diff table' } } },
  { id: '2', kind: 'add', cells: { title: { next: 'Wire accept-all' } } },
  { id: '3', kind: 'remove', cells: { title: { old: 'Stale sync task' } } },
  {
    id: '4',
    kind: 'change',
    cells: { title: { old: 'Draft brief', next: 'Draft brief v2' } },
  },
  {
    id: '5',
    kind: 'change',
    cells: { status: { old: 'todo', next: 'in_progress' } },
  },
];

describe('summarizeDiff', () => {
  test('counts adds, removes, and changes by row kind', () => {
    expect(summarizeDiff(ROWS)).toEqual({ adds: 2, removes: 1, changes: 2 });
  });

  test('returns all zeros for an empty row list', () => {
    expect(summarizeDiff([])).toEqual({ adds: 0, removes: 0, changes: 0 });
  });

  test('counts a single-kind row list', () => {
    const rows: DiffTableRow[] = [
      { id: 'a', kind: 'remove', cells: { title: { old: 'x' } } },
      { id: 'b', kind: 'remove', cells: { title: { old: 'y' } } },
    ];
    expect(summarizeDiff(rows)).toEqual({ adds: 0, removes: 2, changes: 0 });
  });
});
