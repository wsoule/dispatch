import { describe, expect, test } from 'bun:test';

import { filterRows } from './filter-table';

type Task = { id: string; status: string };

const ROWS: Task[] = [
  { id: 't-todo-1', status: 'todo' },
  { id: 't-todo-2', status: 'todo' },
  { id: 't-progress-1', status: 'in-progress' },
  { id: 't-done-1', status: 'done' },
];

const getStatus = (row: Task) => row.status;

describe('filterRows', () => {
  test('empty active returns all rows, unfiltered', () => {
    const result = filterRows(ROWS, [], getStatus);
    expect(result).toEqual(ROWS);
  });

  test('single active status returns only matching rows', () => {
    const result = filterRows(ROWS, ['todo'], getStatus);
    expect(result.map((row) => row.id)).toEqual(['t-todo-1', 't-todo-2']);
  });

  test('multiple active statuses union across matching rows', () => {
    const result = filterRows(ROWS, ['todo', 'done'], getStatus);
    expect(result.map((row) => row.id)).toEqual([
      't-todo-1',
      't-todo-2',
      't-done-1',
    ]);
  });

  test('an active status with no matches returns an empty array', () => {
    const result = filterRows(ROWS, ['blocked'], getStatus);
    expect(result).toEqual([]);
  });

  test('preserves original row order rather than grouping by status', () => {
    const result = filterRows(ROWS, ['done', 'todo'], getStatus);
    expect(result.map((row) => row.id)).toEqual([
      't-todo-1',
      't-todo-2',
      't-done-1',
    ]);
  });
});
