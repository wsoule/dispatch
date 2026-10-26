import { describe, expect, test } from 'bun:test';

import {
  addDays,
  centerXForDate,
  createScale,
  dateForX,
  dayIndex,
  daysBetween,
  dayTicks,
  formatDay,
  formatDayLong,
  isoForDayIndex,
  monthSpans,
  parseDay,
  snapDays,
  weekdayOf,
  weekendSpans,
  weekTicks,
  xForDate,
} from '../src/timeline/dates';

describe('day math', () => {
  test('dayIndex counts whole days from the epoch', () => {
    expect(dayIndex('1970-01-01')).toBe(0);
    expect(dayIndex('1970-01-02')).toBe(1);
    expect(dayIndex('1969-12-31')).toBe(-1);
    expect(dayIndex('2026-10-21')).toBe(20_747);
  });

  test.each([
    ['2026-10-21'],
    ['2028-02-29'],
    ['1999-12-31'],
    ['2000-01-01'],
    ['2027-01-17'],
  ])('isoForDayIndex inverts dayIndex for %s', (iso) => {
    expect(isoForDayIndex(dayIndex(iso))).toBe(iso);
  });

  // The transitions a local-time Date would get wrong: US spring forward
  // (Mar 8 2026), EU (Mar 29, Oct 25 2026) and US fall back (Nov 1 2026).
  test.each([
    ['2026-03-07', '2026-03-09', 2],
    ['2026-03-28', '2026-03-30', 2],
    ['2026-10-24', '2026-10-26', 2],
    ['2026-10-31', '2026-11-02', 2],
    ['2026-01-01', '2027-01-01', 365],
    ['2028-01-01', '2029-01-01', 366],
  ])('daysBetween(%s, %s) is %i whatever the zone', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days);
  });

  test('a whole year steps exactly one day at a time (DST-free)', () => {
    let iso = '2026-01-01';
    for (let i = 0; i < 365; i++) {
      const next = addDays(iso, 1);
      expect(dayIndex(next) - dayIndex(iso)).toBe(1);
      expect(Number.isInteger(dayIndex(next))).toBe(true);
      iso = next;
    }
    expect(iso).toBe('2027-01-01');
  });

  test('addDays crosses months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-21', -7)).toBe('2026-10-14');
  });

  test.each([
    ['2026-02-30'],
    ['2026-13-01'],
    ['2026-1-5'],
    [''],
    ['2026/10/21'],
  ])('parseDay rejects %p', (iso) => {
    expect(() => parseDay(iso)).toThrow(RangeError);
  });

  test('weekdayOf is Monday-first', () => {
    expect(weekdayOf(dayIndex('2026-10-19'))).toBe(0); // Monday
    expect(weekdayOf(dayIndex('2026-10-21'))).toBe(2); // Wednesday
    expect(weekdayOf(dayIndex('2026-10-25'))).toBe(6); // Sunday
    expect(weekdayOf(dayIndex('1969-12-29'))).toBe(0); // before the epoch
  });

  test('formatting is fixed English, with the year only when it differs', () => {
    expect(formatDay('2026-10-19')).toBe('Oct 19');
    expect(formatDayLong('2026-10-19', '2026-10-21')).toBe('Mon, Oct 19');
    expect(formatDayLong('2027-01-04', '2026-10-21')).toBe('Mon, Jan 4, 2027');
    expect(formatDayLong('2027-01-04')).toBe('Mon, Jan 4');
  });
});

describe('date ↔ x', () => {
  const scale = createScale('2026-10-19', '2026-11-15', 32);

  test('the scale covers the window inclusively', () => {
    expect(scale.days).toBe(28);
    expect(scale.width).toBe(28 * 32);
    expect(scale.windowEnd).toBe('2026-11-15');
    expect(createScale('2026-10-19', '2026-10-01', 32).days).toBe(1);
  });

  test('xForDate is the left edge of the day; centerXForDate its middle', () => {
    expect(xForDate('2026-10-19', scale)).toBe(0);
    expect(xForDate('2026-10-21', scale)).toBe(64);
    expect(centerXForDate('2026-10-21', scale)).toBe(80);
    expect(xForDate('2026-10-18', scale)).toBe(-32);
  });

  test('dateForX floor-snaps to the column under x', () => {
    expect(dateForX(0, scale)).toBe('2026-10-19');
    expect(dateForX(31.9, scale)).toBe('2026-10-19');
    expect(dateForX(32, scale)).toBe('2026-10-20');
    expect(dateForX(80, scale)).toBe('2026-10-21');
  });

  test('dateForX round-snaps to the nearest day boundary', () => {
    expect(dateForX(15, scale, 'round')).toBe('2026-10-19');
    expect(dateForX(17, scale, 'round')).toBe('2026-10-20');
  });

  test('dateForX clamps to the window', () => {
    expect(dateForX(-500, scale)).toBe('2026-10-19');
    expect(dateForX(99_999, scale)).toBe('2026-11-15');
  });

  test('dateForX inverts centerXForDate across the window', () => {
    for (let i = 0; i < scale.days; i++) {
      const iso = addDays('2026-10-19', i);
      expect(dateForX(centerXForDate(iso, scale), scale)).toBe(iso);
    }
  });

  test('snapDays rounds a pointer delta to whole days', () => {
    expect(snapDays(0, 32)).toBe(0);
    expect(snapDays(15, 32)).toBe(0);
    expect(snapDays(16, 32)).toBe(1);
    expect(snapDays(70, 32)).toBe(2);
    expect(snapDays(-17, 32)).toBe(-1);
    expect(Object.is(snapDays(-5, 32), -0)).toBe(false);
    expect(snapDays(11, 11)).toBe(1);
  });
});

describe('ticks', () => {
  const scale = createScale('2026-09-23', '2026-12-05', 11);

  test('monthSpans clip the first and last month to the window', () => {
    const spans = monthSpans(scale);
    expect(spans.map((s) => s.key)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(spans.map((s) => s.width / 11)).toEqual([8, 31, 30, 5]);
    expect(spans[0]?.x).toBe(0);
    expect(spans[1]?.x).toBe(8 * 11);
    expect(spans[1]?.label).toBe('October 2026');
    expect(spans[1]?.shortLabel).toBe('Oct 2026');
    expect(spans[1]?.tinyLabel).toBe('Oct');
    expect(spans.reduce((sum, s) => sum + s.width, 0)).toBe(scale.width);
  });

  test('weekTicks start on Mondays; the first is clipped to the window', () => {
    const ticks = weekTicks(scale);
    expect(ticks[0]?.iso).toBe('2026-09-21'); // Monday before Wed 23rd
    expect(ticks[0]?.x).toBe(0);
    expect(ticks[0]?.width).toBe(5 * 11); // Wed–Sun
    expect(ticks[1]?.iso).toBe('2026-09-28');
    expect(ticks[1]?.label).toBe('Sep 28');
    for (const tick of ticks) expect(weekdayOf(dayIndex(tick.iso))).toBe(0);
    expect(ticks.reduce((sum, t) => sum + t.width, 0)).toBe(scale.width);
  });

  test('dayTicks mark weekends; weekendSpans merge Saturday and Sunday', () => {
    const week = createScale('2026-10-19', '2026-11-01', 32);
    const days = dayTicks(week);
    expect(days).toHaveLength(14);
    expect(days.filter((d) => d.weekend).map((d) => d.iso)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(days[13]?.day).toBe(1);
    expect(weekendSpans(week)).toEqual([
      { x: 5 * 32, width: 64 },
      { x: 12 * 32, width: 64 },
    ]);
  });

  test('a window starting on a Sunday opens with a one-day weekend', () => {
    const sunday = createScale('2026-10-25', '2026-10-27', 32);
    expect(weekendSpans(sunday)).toEqual([{ x: 0, width: 32 }]);
  });
});
