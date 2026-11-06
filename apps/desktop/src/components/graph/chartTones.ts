import type { UiTone } from '@dispatch/ui';

import type { ContainerStatus } from '../../lib/containerStatus';
import type { ChartState } from '../../lib/dependencyChart';

// The dependency chart's words and status tones, shared by its nodes, its
// inspector and its legend. Colour only ever comes through `data-tone` on the
// library's hue table: amber for what waits on you, red for failures, blue for
// work moving, green for review, grey for what is idle or done.

/** A milestone's health as a word and a tone. */
export const HEALTH: Record<
  ContainerStatus['health'],
  { label: string; tone: UiTone }
> = {
  attention: { label: 'Attention', tone: 'warning' },
  moving: { label: 'Moving', tone: 'info' },
  idle: { label: 'Idle', tone: 'muted' },
  finished: { label: 'Finished', tone: 'success' },
};

/** The four urgent counts on a milestone card, in the top bar's glyphs. */
export const CELLS = [
  { key: 'asks', glyph: '●', tone: 'warning', label: 'asks' },
  { key: 'failed', glyph: '✕', tone: 'danger', label: 'failed' },
  { key: 'working', glyph: '◐', tone: 'info', label: 'working' },
  { key: 'review', glyph: '◇', tone: 'success', label: 'in review' },
] as const satisfies readonly {
  key: keyof ContainerStatus;
  glyph: string;
  tone: UiTone;
  label: string;
}[];

/**
 * How each task state reads on the chart: its word and its tone. Ready keeps
 * no hue (a heavier neutral ring says it can start); blocked and draft are
 * quiet; landed is dashed and quiet, since it only explains the chains.
 */
export const CHART_STATE: Record<ChartState, { label: string; tone: UiTone }> =
  {
    'need-you': { label: 'Needs you', tone: 'warning' },
    failed: { label: 'Failed', tone: 'danger' },
    working: { label: 'Working', tone: 'info' },
    review: { label: 'In review', tone: 'success' },
    landing: { label: 'Landing', tone: 'info' },
    ready: { label: 'Ready', tone: 'default' },
    blocked: { label: 'Blocked', tone: 'muted' },
    draft: { label: 'Draft', tone: 'muted' },
    landed: { label: 'Landed', tone: 'muted' },
  };

/** The legend's order: what needs a look first, then what moves, then the rest. */
export const STATE_ORDER: readonly ChartState[] = [
  'need-you',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'blocked',
  'draft',
  'landed',
];

/** A due date as "Nov 5", or the raw string when it does not parse. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
