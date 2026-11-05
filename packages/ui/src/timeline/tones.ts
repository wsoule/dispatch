import type { UiTone } from '../types';
import type { TimelineBar, TimelineLane } from './types';

// Which status tone (docs/architecture.md §8.2 "Status colours") the
// timeline's words are drawn in, shared by the chart and the phone cards
// so both colour the same things the same way. Every tone here only
// repeats what a shape or a word already says; an inactive (muted) lane is
// drawn in greys whatever its milestones' status (§2.8: never loud).

/** The tone a lane's sublabel is drawn in (data-tone), or undefined for
 * the quiet grey: only a status tone colours it (warning for "No lead" or
 * a deactivated lead), and never on an inactive lane. */
export function laneSublabelTone(
  lane: Pick<TimelineLane, 'muted' | 'sublabelTone'>
): UiTone | undefined {
  const tone = lane.sublabelTone;
  if (lane.muted === true || tone === undefined) return undefined;
  return tone === 'default' || tone === 'muted' ? undefined : tone;
}

/** The tone of a milestone's receipts line on a phone card: danger when
 * overdue, warning when at risk or missing an input, else default (the
 * quiet grey). `loud` is false on an inactive lane. */
export function receiptsTone(
  bar: Pick<TimelineBar, 'status' | 'missing'>,
  loud: boolean
): UiTone {
  if (!loud) return 'default';
  if (bar.status === 'overdue') return 'danger';
  if (bar.status === 'at_risk') return 'warning';
  if (bar.status === 'missing' || bar.missing !== undefined) return 'warning';
  return 'default';
}

/** The tone of a milestone's due date on a phone card: danger when
 * overdue, else default. `loud` is false on an inactive lane. */
export function barDueTone(
  bar: Pick<TimelineBar, 'status'>,
  loud: boolean
): UiTone {
  return loud && bar.status === 'overdue' ? 'danger' : 'default';
}

/** "No date" on an undated milestone (a chip on the chart, a row on a
 * card): the target date is a missing input, so warning, except on an
 * inactive lane. */
export function undatedTone(loud: boolean): UiTone {
  return loud ? 'warning' : 'default';
}
