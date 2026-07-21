import type { Priority } from '@dispatch/core';

import { cn } from '@/lib/utils';

// Shared 14x14 viewBox/size with `StatusIcon` — see that file's comment for why size is a
// Tailwind class rather than an SVG attribute.
const VIEWBOX = 14;

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent priority',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
  none: 'No priority',
};

// Ascending signal bars, matching Linear's own priority glyph: three bars of increasing
// height, with only as many "filled" (dark) as the priority level out of 3 — the rest render
// faint/muted. `none` skips the bars entirely for a plain "···" (see below).
const BAR_HEIGHTS = [4, 7, 10];
const BAR_WIDTH = 2.6;
const BAR_GAP = 1.4;
const BAR_BASE_Y = 12;

// How many of the three ascending bars render filled (dark) vs faint (muted) — only for
// low/medium/high; `none` renders the dot glyph below and `urgent` renders its own orange
// square, so neither ever looks this map up.
const FILLED_BAR_COUNT: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function SignalBars({ filledCount }: { filledCount: number }) {
  return (
    <>
      {BAR_HEIGHTS.map((height, i) => {
        const x = 1 + i * (BAR_WIDTH + BAR_GAP);
        const y = BAR_BASE_Y - height;
        const filled = i < filledCount;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={BAR_WIDTH}
            height={height}
            rx={0.6}
            className={
              filled ? 'fill-foreground/75' : 'fill-muted-foreground/25'
            }
          />
        );
      })}
    </>
  );
}

// `none` priority: three small horizontal dots ("···"), muted — the common case for most
// tasks, so it deliberately costs almost no visual weight.
function NoneDots() {
  return (
    <>
      {[3, 7, 11].map((cx) => (
        <circle
          key={cx}
          cx={cx}
          cy={10}
          r={0.9}
          className="fill-muted-foreground/40"
        />
      ))}
    </>
  );
}

// `urgent` priority: Linear's filled rounded orange square with a white "!" — built from two
// rounded rects (the exclamation's stem and dot) rather than SVG `<text>`, so it stays crisp
// at 14px without depending on font metrics.
function UrgentGlyph() {
  return (
    <>
      <rect x={0.5} y={0.5} width={13} height={13} rx={3.5} fill="#f2994a" />
      <rect x={6.3} y={3.3} width={1.4} height={5.1} rx={0.7} fill="white" />
      <rect x={6.3} y={9.6} width={1.4} height={1.4} rx={0.7} fill="white" />
    </>
  );
}

export interface PriorityIconProps {
  priority: Priority;
  className?: string;
}

/**
 * Linear's priority glyph: ascending signal bars for low/medium/high (1/2/3 of 3 bars
 * filled), a muted "···" for none, and a filled orange rounded square with a white "!" for
 * urgent — matching Linear's exact look rather than lucide's generic `SignalHigh`/`ChevronsUp`
 * glyphs. Shared between `TaskCardTile`, `EpicCardTile`, and the list view's row.
 */
export function PriorityIcon({ priority, className }: PriorityIconProps) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className={cn('size-3.5 shrink-0', className)}
      role="img"
      aria-label={PRIORITY_LABEL[priority]}
    >
      {priority === 'none' && <NoneDots />}
      {priority === 'urgent' && <UrgentGlyph />}
      {priority !== 'none' && priority !== 'urgent' && (
        <SignalBars filledCount={FILLED_BAR_COUNT[priority]} />
      )}
    </svg>
  );
}
