// Linear's absolute row dates: `Sep 13` on a list row's far right and `Created Sep 13` on a
// board card's footer. Relative time ("2h ago") stays on live surfaces (runs, sessions); a
// task's dates are facts about the record, so they read as a calendar day. The day
// formatter lives here, in app code, next to the task-date helpers built on it.

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
];

/** `Sep 13`, with the year appended (`Sep 13, 2025`) once it is not the current one. Takes
 * an ISO string, epoch ms or a `Date`; an unparseable value reads as a dash rather than
 * `Invalid Date`. `now` is injectable for tests. */
export function formatShortDate(
  value: string | number | Date,
  now: Date = new Date()
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const month = MONTHS[date.getMonth()] ?? '';
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${date.getFullYear()}`;
}

/** The card footer line: `Created Sep 13`. */
export function formatCreated(iso: string, now: Date = new Date()): string {
  return `Created ${formatShortDate(iso, now)}`;
}

/** A calendar day as `YYYY-MM-DD` in local time — the shape `dueDate` stores. */
function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local day `days` after `now`, as `YYYY-MM-DD`. */
export function dayFromNow(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return isoDay(d);
}

export interface DueDateInfo {
  /** `Sep 30`. */
  date: string;
  /** `Today`, `Tomorrow`, `in 5d`, `2d overdue`. */
  relative: string;
  overdue: boolean;
}

/** How a due day reads against today. A task already done is never overdue. */
export function dueDateInfo(
  dueDate: string,
  now: Date = new Date(),
  done = false
): DueDateInfo {
  const [y, m, d] = dueDate.slice(0, 10).split('-').map(Number);
  const due = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const relative =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : days > 1
          ? `in ${days}d`
          : `${-days}d overdue`;
  return {
    date: formatShortDate(due.toISOString(), now),
    relative,
    overdue: !done && days < 0,
  };
}
