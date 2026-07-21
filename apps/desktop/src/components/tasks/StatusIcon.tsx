import { statusTone } from '../../lib/taskDisplay';
import { cn } from '@/lib/utils';

// A single 14x14 viewBox shared by every glyph below — sized via the `size-3.5` Tailwind
// class (not SVG width/height attributes) so callers can override size the same way lucide
// icons in this codebase already do, by passing a different `size-*` class through
// `className`.
const VIEWBOX = 14;
const CENTER = VIEWBOX / 2;
const RADIUS = 5.25;
const STROKE_WIDTH = 1.4;

type StatusShape = 'dashed' | 'empty' | 'pie' | 'check' | 'x';

interface StatusVisual {
  shape: StatusShape;
  /** Tailwind text-color class — drives both `stroke="currentColor"` and
   * `fill="currentColor"` below. */
  colorClass: string;
  /** Pie fill fraction (0..1), only meaningful when `shape === 'pie'`. */
  fraction?: number;
}

// Linear's exact treatment for the six built-in tracker statuses: a shape that reads as
// "how far along is this" (empty ring -> partial pie -> filled check) plus a deliberate
// color, independent of `statusTone`'s badge-oriented palette (see the fallback below for why
// those two mappings intentionally differ).
const KNOWN_STATUS_VISUALS: Record<string, StatusVisual> = {
  backlog: { shape: 'dashed', colorClass: 'text-muted-foreground/50' },
  todo: { shape: 'empty', colorClass: 'text-muted-foreground' },
  'in-progress': {
    shape: 'pie',
    fraction: 0.5,
    colorClass: 'text-amber-500 dark:text-amber-400',
  },
  'in-review': { shape: 'pie', fraction: 0.75, colorClass: 'text-primary' },
  done: { shape: 'check', colorClass: 'text-primary' },
  cancelled: { shape: 'x', colorClass: 'text-muted-foreground' },
};

// Fallback palette for a custom tracker status (anything not in the six built-ins above) —
// keyed by the same six-tone vocabulary `statusTone` already returns for the rest of the app,
// so a project's own `.dispatch/config.yml` status list always renders *something* sensible
// (an empty ring in a deliberate color) rather than an unstyled shape.
const FALLBACK_TONE_COLOR_CLASS: Record<string, string> = {
  green: 'text-emerald-500 dark:text-emerald-400',
  blue: 'text-blue-500 dark:text-blue-400',
  amber: 'text-amber-500 dark:text-amber-400',
  red: 'text-destructive',
  gray: 'text-muted-foreground',
  accent: 'text-primary',
};

function resolveStatusVisual(status: string): StatusVisual {
  const known = KNOWN_STATUS_VISUALS[status];
  if (known !== undefined) return known;
  return {
    shape: 'empty',
    colorClass:
      FALLBACK_TONE_COLOR_CLASS[statusTone(status)] ?? 'text-muted-foreground',
  };
}

/** Builds the `d` attribute for a pie slice covering `fraction` (0..1) of a circle centered
 * at `(cx, cy)` with radius `r`, starting at 12 o'clock and sweeping clockwise — this is what
 * draws the in-progress/in-review half- and three-quarter-filled rings. `fraction` is assumed
 * to be strictly between 0 and 1 (0/1 degenerate to a zero-area or ambiguous arc, so the
 * `check`/`empty` shapes are used for those cases instead of a pie). */
function pieSlicePath(
  cx: number,
  cy: number,
  r: number,
  fraction: number
): string {
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + fraction * 2 * Math.PI;
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const largeArcFlag = fraction > 0.5 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;
}

export interface StatusIconProps {
  status: string;
  className?: string;
}

/**
 * Linear's signature status glyph: a small circle whose stroke/fill pattern encodes how far
 * along a task is — dashed ring (backlog), empty ring (todo), a half/three-quarter pie fill
 * (in-progress/in-review), a filled circle with a check (done), or an X (cancelled). Renders
 * identically in column headers, list group headers, and next to each card/row title (the
 * three call sites the redesign brief asks for), taking only a `status` string so every call
 * site stays config-driven rather than each needing its own copy of the status->glyph map.
 */
export function StatusIcon({ status, className }: StatusIconProps) {
  const visual = resolveStatusVisual(status);
  const pieRadius = RADIUS - STROKE_WIDTH / 2;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className={cn('size-3.5 shrink-0', visual.colorClass, className)}
      role="img"
      aria-label={`Status: ${status}`}
    >
      {visual.shape === 'dashed' && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeDasharray="2 1.6"
        />
      )}
      {visual.shape === 'empty' && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
        />
      )}
      {visual.shape === 'pie' && (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeOpacity={0.35}
          />
          <path
            d={pieSlicePath(CENTER, CENTER, pieRadius, visual.fraction ?? 0.5)}
            fill="currentColor"
          />
        </>
      )}
      {visual.shape === 'check' && (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="currentColor" />
          <path
            d="M4.1 7.2 L6.1 9.2 L9.9 4.9"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {visual.shape === 'x' && (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
          />
          <path
            d="M4.9 4.9 L9.1 9.1 M9.1 4.9 L4.9 9.1"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}
