import { describe, expect, test } from 'bun:test';

import {
  dayFromNow,
  dueDateInfo,
  formatCreated,
  formatShortDate,
} from './taskDates';

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('formatShortDate', () => {
  test('a date in the current year is month and day only', () => {
    expect(formatShortDate('2026-09-13T12:00:00.000Z', NOW)).toBe('Sep 13');
  });

  test('a date in another year carries the year', () => {
    expect(formatShortDate('2025-01-02T12:00:00.000Z', NOW)).toBe(
      'Jan 2, 2025'
    );
  });

  test('an unparseable value reads as a dash', () => {
    expect(formatShortDate('not a date', NOW)).toBe('—');
    expect(formatShortDate('', NOW)).toBe('—');
  });
});

describe('formatCreated', () => {
  test('prefixes the short date', () => {
    expect(formatCreated('2026-09-13T12:00:00.000Z', NOW)).toBe(
      'Created Sep 13'
    );
  });
});

describe('dueDateInfo', () => {
  const noon = new Date(2026, 8, 15, 12);
  test('reads the day against today', () => {
    expect(dueDateInfo('2026-09-15', noon)).toMatchObject({
      relative: 'Today',
      overdue: false,
    });
    expect(dueDateInfo('2026-09-16', noon).relative).toBe('Tomorrow');
    expect(dueDateInfo('2026-09-20', noon)).toMatchObject({
      date: 'Sep 20',
      relative: 'in 5d',
    });
  });

  test('a past day is overdue unless the task is done', () => {
    expect(dueDateInfo('2026-09-13', noon)).toMatchObject({
      relative: '2d overdue',
      overdue: true,
    });
    expect(dueDateInfo('2026-09-13', noon, true).overdue).toBe(false);
  });
});

test('dayFromNow counts local calendar days', () => {
  expect(dayFromNow(0, new Date(2026, 8, 30, 23))).toBe('2026-09-30');
  expect(dayFromNow(1, new Date(2026, 8, 30, 23))).toBe('2026-10-01');
});
