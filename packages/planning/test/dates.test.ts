import { describe, expect, test } from 'bun:test';

import {
  addDays,
  diffDays,
  elapsedMs,
  formatDisplayDate,
  isValidIsoDate,
  isValidTimeZone,
  todayIn,
} from '../src/index';

describe('todayIn', () => {
  test.each([
    // [timeZone, instant, expected local date]
    ['UTC', '2026-10-21T23:59:59.999Z', '2026-10-21'],
    ['UTC', '2026-10-22T00:00:00.000Z', '2026-10-22'],
    // 04:30 UTC is still the previous evening in Chicago (UTC-5 in October).
    ['America/Chicago', '2026-10-22T04:30:00.000Z', '2026-10-21'],
    ['America/Chicago', '2026-10-22T05:00:00.000Z', '2026-10-22'],
    // UTC+14: already tomorrow.
    ['Pacific/Kiritimati', '2026-10-21T12:00:00.000Z', '2026-10-22'],
    // Year boundary.
    ['Asia/Tokyo', '2026-12-31T15:30:00.000Z', '2027-01-01'],
    // The night US clocks fall back (2026-11-01 02:00 CDT → 01:00 CST).
    ['America/Chicago', '2026-11-01T05:30:00.000Z', '2026-11-01'],
    ['America/Chicago', '2026-11-02T05:59:00.000Z', '2026-11-01'],
  ])('%s at %s is %s', (timeZone, instant, expected) => {
    expect(todayIn(timeZone, new Date(instant))).toBe(expected);
  });

  test('throws for an unknown timezone', () => {
    expect(() =>
      todayIn('Nope/Zone', new Date('2026-10-21T00:00:00Z'))
    ).toThrow();
  });
});

describe('addDays', () => {
  test.each([
    ['2026-10-21', 0, '2026-10-21'],
    ['2026-10-21', 7, '2026-10-28'],
    ['2026-10-21', -21, '2026-09-30'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    // Across both 2026 US DST transitions: still exact calendar days.
    ['2026-03-07', 2, '2026-03-09'],
    ['2026-10-31', 2, '2026-11-02'],
  ])('%s + %d = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  test('rejects a malformed date', () => {
    expect(() => addDays('2026-13-01', 1)).toThrow(RangeError);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite count (%d) instead of returning NaN-NaN-NaN',
    (days) => {
      expect(() => addDays('2026-10-21', days)).toThrow(RangeError);
    }
  );

  test('truncates fractional counts toward zero', () => {
    expect(addDays('2026-10-21', 1.9)).toBe('2026-10-22');
    expect(addDays('2026-10-21', -1.9)).toBe('2026-10-20');
  });

  test('two-digit years stay in their own century', () => {
    // Date.UTC would read year 50 as 1950.
    expect(addDays('0050-01-01', 1)).toBe('0050-01-02');
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
  });
});

describe('diffDays', () => {
  test.each([
    ['2026-10-28', '2026-10-21', 7],
    ['2026-10-21', '2026-10-28', -7],
    ['2026-10-21', '2026-10-21', 0],
    ['2027-01-01', '2026-12-31', 1],
    ['2028-03-01', '2028-02-28', 2],
    // DST transitions do not create 23- or 25-hour "days".
    ['2026-03-09', '2026-03-07', 2],
    ['2026-11-02', '2026-10-31', 2],
    ['2026-03-30', '2026-03-28', 2],
  ])('%s - %s = %d', (later, earlier, expected) => {
    expect(diffDays(later, earlier)).toBe(expected);
  });

  test('two-digit years count real days', () => {
    expect(diffDays('0100-01-01', '0099-12-31')).toBe(1);
  });

  test('is the inverse of addDays', () => {
    for (let n = -400; n <= 400; n += 37) {
      expect(diffDays(addDays('2026-10-21', n), '2026-10-21')).toBe(n);
    }
  });
});

describe('isValidIsoDate', () => {
  test.each([
    ['2026-10-21', true],
    ['2028-02-29', true],
    ['2027-02-29', false],
    // Year 0 is a leap year in the proleptic Gregorian calendar (1900 is not).
    ['0000-02-29', true],
    ['2026-04-31', false],
    ['2026-00-10', false],
    ['2026-10-00', false],
    ['2026-1-21', false],
    ['2026-10-21T00:00:00Z', false],
    ['', false],
    ['not a date', false],
  ])('%s → %s', (value, expected) => {
    expect(isValidIsoDate(value)).toBe(expected);
  });
});

describe('isValidTimeZone', () => {
  test.each([
    ['UTC', true],
    ['America/Chicago', true],
    ['Europe/Oslo', true],
    ['Nope/Zone', false],
    ['', false],
    ['   ', false],
  ])('%s → %s', (value, expected) => {
    expect(isValidTimeZone(value)).toBe(expected);
  });
});

describe('formatDisplayDate', () => {
  test.each([
    ['2026-10-28', 'Oct 28, 2026'],
    ['2026-01-01', 'Jan 1, 2026'],
    ['2027-12-09', 'Dec 9, 2027'],
    ['garbage', 'garbage'],
  ])('%s → %s', (date, expected) => {
    expect(formatDisplayDate(date)).toBe(expected);
  });
});

describe('elapsedMs', () => {
  test('measures instants across offsets', () => {
    expect(
      elapsedMs('2026-10-21T12:00:00.000Z', '2026-10-21T06:00:00.000-05:00')
    ).toBe(3_600_000);
  });

  test('returns null for unparseable input', () => {
    expect(elapsedMs('nope', '2026-10-21T00:00:00Z')).toBeNull();
  });
});
