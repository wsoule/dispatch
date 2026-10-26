import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';

import type { RecordsColumn, RecordsRow, RecordsSort } from './records-table';
import { formatRecordsDate, RecordsTable, sortRows } from './records-table';

const COLUMNS: RecordsColumn[] = [
  { key: 'title', label: 'Title' },
  { key: 'attempts', label: 'Attempts', kind: 'text' },
  { key: 'lastRun', label: 'Last run', kind: 'time' },
  { key: 'confidence', label: 'Confidence', kind: 'strength' },
  { key: 'tags', label: 'Tags', kind: 'tags' },
];

const ROWS: RecordsRow[] = [
  {
    id: 'r-cacao',
    cells: {
      title: 'Cacao Norte',
      attempts: 9,
      lastRun: '2026-08-09T12:00:00.000Z',
      confidence: 1,
      tags: ['ops'],
    },
  },
  {
    id: 'r-andes',
    cells: {
      title: 'Andes Snow',
      attempts: 2,
      lastRun: '2026-08-11T09:00:00.000Z',
      confidence: 3,
      tags: ['gelato', 'catering'],
    },
  },
  {
    id: 'r-blue-fig',
    cells: {
      title: 'Blue Fig',
      attempts: 12,
      lastRun: '2026-08-01T12:00:00.000Z',
      confidence: 2,
      tags: ['cafe'],
    },
  },
];

describe('sortRows', () => {
  test('returns rows unchanged, as a new array, when sort is null', () => {
    const result = sortRows(ROWS, COLUMNS, null);
    expect(result).toEqual(ROWS);
    expect(result).not.toBe(ROWS);
  });

  test('sorts strings alphabetically (asc/desc) for a text column', () => {
    const asc = sortRows(ROWS, COLUMNS, { key: 'title', dir: 'asc' });
    expect(asc.map((row) => row.id)).toEqual([
      'r-andes',
      'r-blue-fig',
      'r-cacao',
    ]);

    const desc = sortRows(ROWS, COLUMNS, { key: 'title', dir: 'desc' });
    expect(desc.map((row) => row.id)).toEqual([
      'r-cacao',
      'r-blue-fig',
      'r-andes',
    ]);
  });

  test('sorts numbers numerically, not lexicographically', () => {
    const asc = sortRows(ROWS, COLUMNS, { key: 'attempts', dir: 'asc' });
    // Lexicographic sort would put "12" before "2"; numeric sort must not.
    expect(asc.map((row) => row.id)).toEqual([
      'r-andes',
      'r-cacao',
      'r-blue-fig',
    ]);
  });

  test('sorts a time column chronologically from ISO strings', () => {
    const asc = sortRows(ROWS, COLUMNS, { key: 'lastRun', dir: 'asc' });
    expect(asc.map((row) => row.id)).toEqual([
      'r-blue-fig',
      'r-cacao',
      'r-andes',
    ]);
  });

  test('sorts a strength column numerically', () => {
    const desc = sortRows(ROWS, COLUMNS, { key: 'confidence', dir: 'desc' });
    expect(desc.map((row) => row.id)).toEqual([
      'r-andes',
      'r-blue-fig',
      'r-cacao',
    ]);
  });

  test('sorts a tags column by its joined label', () => {
    const asc = sortRows(ROWS, COLUMNS, { key: 'tags', dir: 'asc' });
    expect(asc.map((row) => row.id)).toEqual([
      'r-blue-fig',
      'r-andes',
      'r-cacao',
    ]);
  });

  test('is stable: rows tied on the sort key keep their original relative order', () => {
    const tiedRows: RecordsRow[] = [
      { id: 'first', cells: { title: 'Same', attempts: 1 } },
      { id: 'second', cells: { title: 'Same', attempts: 2 } },
      { id: 'third', cells: { title: 'Same', attempts: 3 } },
    ];
    const result = sortRows(tiedRows, COLUMNS, { key: 'title', dir: 'asc' });
    expect(result.map((row) => row.id)).toEqual(['first', 'second', 'third']);
  });

  test('unknown sort key leaves rows in their original order', () => {
    const result = sortRows(ROWS, COLUMNS, { key: 'nonexistent', dir: 'asc' });
    expect(result.map((row) => row.id)).toEqual(ROWS.map((row) => row.id));
  });
});

// Rendering is exercised with `createElement` (this is a `.ts` file) against happy-dom.
describe('RecordsTable rows', () => {
  const NOW = new Date('2026-09-15T12:00:00.000Z');

  test('formatRecordsDate is the absolute `Sep 13`, with the year only when it differs', () => {
    expect(formatRecordsDate('2026-09-13T12:00:00.000Z', NOW)).toBe('Sep 13');
    expect(formatRecordsDate('2025-01-02T12:00:00.000Z', NOW)).toBe(
      'Jan 2, 2025'
    );
    expect(formatRecordsDate(undefined, NOW)).toBeNull();
  });

  test('renders ListRows with no header row by default', () => {
    const { container } = render(
      createElement(RecordsTable, {
        columns: COLUMNS,
        rows: ROWS,
        sort: null,
      })
    );
    expect(container.querySelector('[data-slot="records-header"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    const rows = container.querySelectorAll('[data-slot="list-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.className.split(/\s+/)).toContain('h-9');
  });

  test('showHeader adds the label row with sort buttons', () => {
    const sorts: RecordsSort[] = [];
    render(
      createElement(RecordsTable, {
        columns: COLUMNS,
        rows: ROWS,
        sort: null,
        showHeader: true,
        onSortChange: (next) => sorts.push(next),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Title' }));
    expect(sorts).toEqual([{ key: 'title', dir: 'asc' }]);
  });

  test('a time column lands in the date slot as an absolute day; tags become label pills', () => {
    const { container } = render(
      createElement(RecordsTable, {
        columns: COLUMNS,
        rows: ROWS.slice(1, 2),
        sort: null,
      })
    );
    const date = container.querySelector('[data-slot="list-row-date"]');
    expect(date?.textContent).toMatch(/^Aug 11(, 2026)?$/);
    expect(date?.className.split(/\s+/)).not.toContain('font-mono');
    const pills = container.querySelectorAll('[data-slot="label-pill"]');
    expect([...pills].map((p) => p.textContent)).toEqual([
      'gelato',
      'catering',
    ]);
  });

  test('selectable rows carry the hover checkbox and grouped sections a GroupHeader', () => {
    const toggled: string[] = [];
    const { container } = render(
      createElement(RecordsTable, {
        columns: COLUMNS,
        groups: [{ key: 'g', name: 'Ready', rows: ROWS, onToggle: () => {} }],
        sort: null,
        selectable: true,
        onToggleSelect: (id) => toggled.push(id),
      })
    );
    expect(
      container.querySelector('[data-slot="group-header-name"]')?.textContent
    ).toBe('Ready');
    fireEvent.click(screen.getByLabelText('Select r-cacao'));
    expect(toggled).toEqual(['r-cacao']);
  });
});
