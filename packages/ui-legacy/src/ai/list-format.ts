// The two presentation helpers a Linear-style row shares with the app: the label pill's dot
// colour and the far-right absolute date. One home so `ui` records and app tasks wear the
// same hue for the same label and the same `Sep 13` for the same day.

const LABEL_COLOR_COUNT = 8;

/** Deterministically maps a label name to one of the `--project-color-1..8` tokens, so `ui`
 * is the same hue on every pill without anyone storing a colour per label. */
export function colorForLabel(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 33 + label.charCodeAt(i)) >>> 0;
  }
  return `var(--project-color-${(hash % LABEL_COLOR_COUNT) + 1})`;
}

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
