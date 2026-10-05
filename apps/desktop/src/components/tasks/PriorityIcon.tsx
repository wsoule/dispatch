import type { Priority } from '@dispatch-foo/core/browser';

import { priorityLabel } from '../../lib/taskDisplay';
import { cn } from '@/lib/utils';

// Linear's priority glyph, rects read from its SVG DOM: a 16×16 viewBox with three rounded
// bars at x = 1.5 / 6.5 / 11.5, filled in `currentColor` (muted grey on rows). Sized via the
// `size-3.5` Tailwind class the same way `StatusIcon` is.
const VIEWBOX = 16;

// The three ascending bars (x, y, height) — the same rects for low/medium/high, with the
// bars above the level faded to 40%.
const BARS: readonly { x: number; y: number; height: number }[] = [
  { x: 1.5, y: 8, height: 6 },
  { x: 6.5, y: 5, height: 9 },
  { x: 11.5, y: 2, height: 12 },
];
const BAR_WIDTH = 3;
const FADED_OPACITY = 0.4;

// How many of the three bars render solid — `none` and `urgent` have their own glyphs and
// never look this up.
const FILLED_BAR_COUNT: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function SignalBars({ filledCount }: { filledCount: number }) {
  return (
    <>
      {BARS.map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width={BAR_WIDTH}
          height={bar.height}
          rx={1}
          fillOpacity={i < filledCount ? undefined : FADED_OPACITY}
        />
      ))}
    </>
  );
}

// `none`: three short dashes on the centre line ("···"), the common case for most tasks,
// so it deliberately costs almost no visual weight.
function NoneDashes() {
  return (
    <>
      {BARS.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={7.25}
          width={BAR_WIDTH}
          height={1.5}
          rx={0.5}
          opacity={0.9}
        />
      ))}
    </>
  );
}

// `urgent`: the filled orange rounded square with a white "!" — a 1.5-wide rounded bar
// from y=3.5 to y=9 and a dot centred at y=11.5, both centred on x=8.
function UrgentGlyph() {
  return (
    <>
      <rect
        x={1}
        y={1}
        width={14}
        height={14}
        rx={3}
        fill="var(--priority-urgent)"
      />
      <rect x={7.25} y={3.5} width={1.5} height={5.5} rx={0.75} fill="white" />
      <rect
        x={7.25}
        y={10.75}
        width={1.5}
        height={1.5}
        rx={0.75}
        fill="white"
      />
    </>
  );
}

export interface PriorityIconProps {
  priority: Priority;
  className?: string;
}

/**
 * Linear's priority glyph at its exact geometry: ascending bars for low/medium/high (1/2/3
 * of 3 solid, the rest at 40%), three dashes for none, and a filled orange square with a
 * white "!" for urgent. Grey bars take the muted text colour; pass a `text-*` class to
 * recolour.
 */
export function PriorityIcon({ priority, className }: PriorityIconProps) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      fill="currentColor"
      className={cn('size-3.5 shrink-0 text-muted-foreground', className)}
      role="img"
      aria-label={priorityLabel(priority)}
      data-priority={priority}
    >
      {priority === 'none' && <NoneDashes />}
      {priority === 'urgent' && <UrgentGlyph />}
      {priority !== 'none' && priority !== 'urgent' && (
        <SignalBars filledCount={FILLED_BAR_COUNT[priority]} />
      )}
    </svg>
  );
}
