import { formatDayLong } from './dates';
import type { TimelineBar } from './types';

/**
 * The spoken parts of a milestone, in reading order: name, status, due
 * date, progress, tags, the missing input. Shared by the chart bars and the
 * phone cards so both read out the same sentence.
 */
export function describeMilestone(bar: TimelineBar, today: string): string[] {
  const parts = [
    bar.label,
    bar.statusLabel,
    `due ${formatDayLong(bar.end, today)}`,
  ];
  if (bar.progressLabel !== undefined) parts.push(`${bar.progressLabel} done`);
  for (const tag of bar.tags ?? []) parts.push(tag);
  if (bar.missing !== undefined) parts.push(bar.missing);
  return parts;
}
