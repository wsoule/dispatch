// Calendar math for the workspace timezone. Instants are ISO strings in UTC;
// "today", "days left" and due dates are plain `YYYY-MM-DD` calendar dates.
// Every calendar operation works on UTC midnight of the date parts, so no
// result depends on the host's timezone or on daylight-saving transitions.

import type { IsoDate, IsoDateTime } from './types';

/** Milliseconds in one day (24 hours of elapsed time). */
export const DAY_MS: number = 86_400_000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_SHORT_NAMES: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// One formatter per timezone: constructing Intl.DateTimeFormat is expensive
// and todayIn runs on every request.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

// Returns a cached formatter that yields numeric Gregorian year/month/day
// parts in `timeZone`, independent of the host locale.
function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// UTC-midnight epoch milliseconds of year/month index/day. Date.UTC reads
// years 0–99 as 1900–1999, so the year is set with setUTCFullYear instead,
// which keeps every four-digit year exact.
function utcDateMs(year: number, monthIndex: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date.getTime();
}

// Parses `YYYY-MM-DD` into its numeric parts, or null when the string is not
// a real calendar date (e.g. `2026-02-30`).
function parseDateParts(
  value: string
): { year: number; month: number; day: number } | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the next month is the last day of this month.
  const lastDay = new Date(utcDateMs(year, month, 0)).getUTCDate();
  if (day > lastDay) return null;
  return { year, month, day };
}

// UTC-midnight epoch milliseconds of a calendar date; throws on bad input so
// a malformed date never turns into a silent NaN.
function utcMidnight(value: IsoDate): number {
  const parts = parseDateParts(value);
  if (parts === null) {
    throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${value}`);
  }
  return utcDateMs(parts.year, parts.month - 1, parts.day);
}

// Formats UTC-midnight epoch milliseconds back into `YYYY-MM-DD`.
function formatUtcDate(ms: number): IsoDate {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The calendar date it is in `timeZone` at the instant `now`. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  let year = '';
  let month = '';
  let day = '';
  for (const part of calendarFormatter(timeZone).formatToParts(now)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * `date` plus `days` calendar days (negative goes back; fractions are
 * truncated). Throws RangeError for a malformed date or a non-finite count.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isFinite(days)) {
    throw new RangeError(`Not a finite number of days: ${days}`);
  }
  return formatUtcDate(utcMidnight(date) + Math.trunc(days) * DAY_MS);
}

/** Whole calendar days from `earlier` to `later` (negative if later < earlier). */
export function diffDays(later: IsoDate, earlier: IsoDate): number {
  return Math.round((utcMidnight(later) - utcMidnight(earlier)) / DAY_MS);
}

/** True for a real `YYYY-MM-DD` calendar date. */
export function isValidIsoDate(value: string): boolean {
  return parseDateParts(value) !== null;
}

/** True when the runtime knows `value` as an IANA timezone (e.g. `Europe/Oslo`). */
export function isValidTimeZone(value: string): boolean {
  if (value.trim() === '') return false;
  try {
    calendarFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A calendar date as `Oct 28, 2026`. Built from a fixed English month table
 * rather than toLocaleDateString so Linear comments read the same on every
 * host. Returns the input unchanged when it is not a calendar date.
 */
export function formatDisplayDate(date: IsoDate): string {
  const parts = parseDateParts(date);
  if (parts === null) return date;
  return `${MONTH_SHORT_NAMES[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/**
 * Elapsed milliseconds from `earlier` to `later` (both ISO instants), or null
 * when either does not parse.
 */
export function elapsedMs(
  later: IsoDateTime,
  earlier: IsoDateTime
): number | null {
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a - b;
}
