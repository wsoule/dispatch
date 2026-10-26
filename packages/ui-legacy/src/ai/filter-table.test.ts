import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';

import { FilterChips, filterRows } from './filter-table';

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

// The chips are the `ViewTabs` pills: 28px, control surface off, lifted when on, the
// count as plain 11px text rather than a badge.
describe('FilterChips', () => {
  test('active chips lift and counts are plain text', () => {
    render(
      createElement(FilterChips, {
        options: [
          { id: 'todo', label: 'To do' },
          { id: 'done', label: 'Done' },
        ],
        active: ['todo'],
        onToggle: () => {},
        counts: { todo: 2, done: 1 },
      })
    );
    const todo = screen.getByRole('button', { name: /To do/ });
    const done = screen.getByRole('button', { name: /Done/ });
    expect(todo.getAttribute('aria-pressed')).toBe('true');
    expect(todo.className.split(/\s+/)).toContain('h-7');
    expect(todo.className).toContain('bg-surface-active');
    expect(done.className).toContain('bg-surface-control');
    const count = screen.getByText('2');
    expect(count.className).toContain('text-[11px]');
    expect(count.className).not.toContain('font-mono');
    expect(count.className).not.toContain('bg-');
  });
});
