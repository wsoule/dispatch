// Human wording for dates and countdowns on the timeline and in the milestone
// section, so the chart, its banners and the drawer say "Oct 28", "in 3 days",
// "3 days overdue" and "2 projects" the same way. Ported from the planner's
// lib/format.ts (Better-Tracker), keeping only the helpers the timeline
// adapters read. Pure functions over YYYY-MM-DD strings with no locale or
// timezone dependence: @dispatch/planning already decided what "today" is.

const MONTHS = [
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

/** The year, month and day of a YYYY-MM-DD string; throws on anything else so
 * a malformed date is a loud bug, never a silently wrong label. */
function parts(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** "Oct 28", or "Oct 28, 2026" when the year differs from `today`'s (or no
 * `today` is given). */
export function formatDate(date: string, today?: string): string {
  const { y, m, d } = parts(date);
  const short = `${MONTHS[m - 1]} ${d}`;
  if (today === undefined) return `${short}, ${y}`;
  return parts(today).y === y ? short : `${short}, ${y}`;
}

/** "due today", "due tomorrow", "in 3 days", "1 day overdue", "3 days overdue". */
export function daysLeftPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return 'due tomorrow';
  if (daysLeft > 1) return `in ${daysLeft} days`;
  const late = -daysLeft;
  return late === 1 ? '1 day overdue' : `${late} days overdue`;
}

/**
 * "Oct 28 · in 3 days"; "No target date" when there is no date. Pass the
 * milestone's status where it is known: a complete milestone (every issue
 * done or canceled) has no countdown, since finished work is never "20 days
 * overdue" or "in 3 days", so it reads "Oct 1 · complete".
 */
export function dueLabel(
  targetDate: string | null,
  daysLeft: number | null,
  today: string,
  status?: string | null
): string {
  if (targetDate === null) return 'No target date';
  const when = formatDate(targetDate, today);
  if (status === 'complete') return `${when} · complete`;
  return daysLeft === null ? when : `${when} · ${daysLeftPhrase(daysLeft)}`;
}

/** Pluralises a count: plural(3, 'issue') → "3 issues"; `many` for an
 * irregular plural (plural(2, 'person', 'people')). */
export function plural(count: number, noun: string, many?: string): string {
  return `${count} ${count === 1 ? noun : (many ?? `${noun}s`)}`;
}
