// Pure calendar-day and date↔x helpers for the timeline. A day is a
// 'YYYY-MM-DD' string with no time or zone; all arithmetic goes through
// whole-day indexes built with Date.UTC, so daylight-saving transitions in
// the viewer's zone can never stretch or shrink a day (a local-time Date
// would make 2026-03-08 → 2026-03-09 last 23 hours in New York).

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const MONTHS_SHORT = [
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
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface DayParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

/** Splits a 'YYYY-MM-DD' day, rejecting malformed and impossible dates
 * (2026-02-30) so a bad prop fails loudly instead of drawing garbage. */
export function parseDay(iso: string): DayParts {
  const match = ISO_DAY.exec(iso);
  if (match === null) throw new RangeError(`Not a YYYY-MM-DD day: "${iso}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a calendar day: "${iso}"`);
  }
  return { year, month, day };
}

/** Whole days since 1970-01-01 (negative before it). */
export function dayIndex(iso: string): number {
  const { year, month, day } = parseDay(iso);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/** The 'YYYY-MM-DD' day for a day index (inverse of dayIndex). */
export function isoForDayIndex(index: number): string {
  const date = new Date(index * MS_PER_DAY);
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  return isoForDayIndex(dayIndex(iso) + days);
}

/** `to - from` in whole calendar days. */
export function daysBetween(from: string, to: string): number {
  return dayIndex(to) - dayIndex(from);
}

/** 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday). */
export function weekdayOf(index: number): number {
  return (((index + 3) % 7) + 7) % 7;
}

/** The earlier / later of two days. */
export function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

/** 'Oct 19' */
export function formatDay(iso: string): string {
  const { month, day } = parseDay(iso);
  return `${MONTHS_SHORT[month - 1] ?? ''} ${day}`;
}

/** 'Mon, Oct 19', with the year when it differs from `referenceYearOf`'s
 * (so a January deadline seen in October says 2027). */
export function formatDayLong(iso: string, referenceYearOf?: string): string {
  const { year } = parseDay(iso);
  const weekday = WEEKDAYS_SHORT[weekdayOf(dayIndex(iso))] ?? '';
  const sameYear =
    referenceYearOf === undefined || parseDay(referenceYearOf).year === year;
  return `${weekday}, ${formatDay(iso)}${sameYear ? '' : `, ${year}`}`;
}

/* ---- the scale -------------------------------------------------------- */

/**
 * Maps the window [start, end] (inclusive days) onto x pixels: day i of the
 * window owns the column [i·dayWidth, (i+1)·dayWidth). Dates are drawn at
 * the centre of their column (bars, diamonds and the today line share it),
 * so a milestone due today sits exactly on the rule.
 */
export interface TimeScale {
  /** dayIndex(windowStart) */
  origin: number;
  /** Number of days drawn (end - start + 1, at least 1). */
  days: number;
  dayWidth: number;
  /** days × dayWidth */
  width: number;
  windowStart: string;
  windowEnd: string;
}

export function createScale(
  windowStart: string,
  windowEnd: string,
  dayWidth: number
): TimeScale {
  const origin = dayIndex(windowStart);
  const days = Math.max(1, dayIndex(windowEnd) - origin + 1);
  return {
    origin,
    days,
    dayWidth,
    width: days * dayWidth,
    windowStart,
    windowEnd: isoForDayIndex(origin + days - 1),
  };
}

/** x of the left edge of a day's column (may fall outside [0, width]). */
export function xForDate(iso: string, scale: TimeScale): number {
  return (dayIndex(iso) - scale.origin) * scale.dayWidth;
}

/** x of the centre of a day's column: where a date is drawn. */
export function centerXForDate(iso: string, scale: TimeScale): number {
  return xForDate(iso, scale) + scale.dayWidth / 2;
}

/**
 * The day at x, snapped to whole days and clamped to the window.
 * 'floor' = the day whose column contains x (what a pointer is over);
 * 'round' = the day whose column starts at the boundary nearest x.
 */
export function dateForX(
  x: number,
  scale: TimeScale,
  snap: 'floor' | 'round' = 'floor'
): string {
  const raw = x / scale.dayWidth;
  const offset = snap === 'floor' ? Math.floor(raw) : Math.round(raw);
  const clamped = Math.min(scale.days - 1, Math.max(0, offset));
  return isoForDayIndex(scale.origin + clamped);
}

/** Whole days a pointer moved: dx pixels rounded to the nearest day. */
export function snapDays(dx: number, dayWidth: number): number {
  const days = Math.round(dx / dayWidth);
  return days === 0 ? 0 : days; // no -0
}

/* ---- ticks ------------------------------------------------------------ */

export interface MonthSpan {
  /** 'YYYY-MM' */
  key: string;
  /** 'October 2026' */
  label: string;
  /** 'Oct 2026', for a month only partly in the window. */
  shortLabel: string;
  /** 'Oct' */
  tinyLabel: string;
  x: number;
  width: number;
}

/** One span per calendar month overlapping the window, clipped to it. */
export function monthSpans(scale: TimeScale): MonthSpan[] {
  const spans: MonthSpan[] = [];
  let i = 0;
  while (i < scale.days) {
    const iso = isoForDayIndex(scale.origin + i);
    const { year, month } = parseDay(iso);
    const nextMonthStart = Math.round(Date.UTC(year, month, 1) / MS_PER_DAY);
    const end = Math.min(scale.days, nextMonthStart - scale.origin);
    spans.push({
      key: iso.slice(0, 7),
      label: `${MONTHS_LONG[month - 1] ?? ''} ${year}`,
      shortLabel: `${MONTHS_SHORT[month - 1] ?? ''} ${year}`,
      tinyLabel: MONTHS_SHORT[month - 1] ?? '',
      x: i * scale.dayWidth,
      width: (end - i) * scale.dayWidth,
    });
    i = end;
  }
  return spans;
}

export interface DayTick {
  iso: string;
  x: number;
  /** Day of the month, 1–31. */
  day: number;
  weekend: boolean;
}

/** Every day of the window (the weeks zoom's tick row). */
export function dayTicks(scale: TimeScale): DayTick[] {
  const ticks: DayTick[] = [];
  for (let i = 0; i < scale.days; i++) {
    const index = scale.origin + i;
    const iso = isoForDayIndex(index);
    ticks.push({
      iso,
      x: i * scale.dayWidth,
      day: Number(iso.slice(8, 10)),
      weekend: weekdayOf(index) >= 5,
    });
  }
  return ticks;
}

export interface WeekTick {
  /** The week's Monday (may precede the window for the first tick). */
  iso: string;
  x: number;
  width: number;
  /** 'Oct 19' */
  label: string;
}

/** ISO weeks (Monday-first) overlapping the window, clipped to it (the
 * months zoom's tick row and every zoom's week gridlines). */
export function weekTicks(scale: TimeScale): WeekTick[] {
  const ticks: WeekTick[] = [];
  const firstMonday = scale.origin - weekdayOf(scale.origin);
  for (let monday = firstMonday; monday < scale.origin + scale.days; ) {
    const from = Math.max(monday, scale.origin) - scale.origin;
    const to = Math.min(monday + 7, scale.origin + scale.days) - scale.origin;
    const iso = isoForDayIndex(monday);
    ticks.push({
      iso,
      x: from * scale.dayWidth,
      width: (to - from) * scale.dayWidth,
      label: formatDay(iso),
    });
    monday += 7;
  }
  return ticks;
}

export interface Span {
  x: number;
  width: number;
}

/** Contiguous Saturday–Sunday runs inside the window (shaded with --sunken
 * in the weeks zoom). */
export function weekendSpans(scale: TimeScale): Span[] {
  const spans: Span[] = [];
  let runStart = -1;
  for (let i = 0; i <= scale.days; i++) {
    const weekend = i < scale.days && weekdayOf(scale.origin + i) >= 5;
    if (weekend && runStart < 0) runStart = i;
    if (!weekend && runStart >= 0) {
      spans.push({
        x: runStart * scale.dayWidth,
        width: (i - runStart) * scale.dayWidth,
      });
      runStart = -1;
    }
  }
  return spans;
}
