import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useId, useState } from 'react';

type InsightDeltaDirection = 'up' | 'down' | 'flat';

export type InsightDelta = {
  value: string;
  direction: InsightDeltaDirection;
};

export type InsightCardProps = {
  title: string;
  summary: string;
  series: number[];
  unit: string;
  delta: InsightDelta;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
};

type ChartPoint = { x: number; y: number };

const CHART_WIDTH = 264;
const CHART_HEIGHT = 96;

// Maps a data series onto an SVG viewbox of size w x h. A single value has no
// meaningful spread, so it's centered on both axes rather than dividing by a
// zero-length range. A flat multi-point series (every value equal) is centered
// vertically only — x still spreads across the full width — so "no change"
// reads as a flat centered line instead of collapsing to one point.
export function pointsFromSeries(
  series: number[],
  w: number,
  h: number
): ChartPoint[] {
  if (series.length === 0) return [];
  if (series.length === 1) return [{ x: w / 2, y: h / 2 }];

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;

  return series.map((value, index) => ({
    x: (index / (series.length - 1)) * w,
    y: range === 0 ? h / 2 : h - ((value - min) / range) * h,
  }));
}

// Builds the stroke path for the area chart's line — a moveto for the first
// point followed by linetos for the rest. Reused as the basis for the filled
// area path (the component closes it down to the baseline).
export function pathFromSeries(series: number[], w: number, h: number): string {
  const points = pointsFromSeries(series, w, h);
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ');
}

// Converts a pointer's horizontal offset within the chart into the nearest
// series index, clamped to the series bounds. Kept separate from any DOM
// lookup (bounding rect, etc.) so the index math is pure and testable.
export function indexFromOffsetX(
  offsetX: number,
  width: number,
  length: number
): number {
  if (length <= 0) return -1;
  if (length === 1 || width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, offsetX / width));
  return Math.round(ratio * (length - 1));
}

const DELTA_STYLES: Record<
  InsightDeltaDirection,
  { icon: typeof TrendingUpIcon; chipClassName: string; iconClassName: string }
> = {
  up: {
    icon: TrendingUpIcon,
    chipClassName: 'bg-[var(--green-bg)] text-[var(--green)]',
    iconClassName: 'text-[var(--green)]',
  },
  down: {
    icon: TrendingDownIcon,
    chipClassName: 'bg-[var(--red-bg)] text-[var(--red)]',
    iconClassName: 'text-[var(--red)]',
  },
  flat: {
    icon: MinusIcon,
    chipClassName: 'bg-[var(--gray-bg)] text-[var(--gray)]',
    iconClassName: 'text-[var(--gray)]',
  },
};

/** Small pill showing a signed delta, tinted by direction: green for up, red for
 * down, gray for flat — never a bare number with no visual weight. */
function DeltaChip({ delta }: { delta: InsightDelta }) {
  const style = DELTA_STYLES[delta.direction];
  const Icon = style.icon;
  return (
    <span
      className={`rounded-chip inline-flex h-6 shrink-0 items-center gap-1 px-2 text-[11.5px] font-medium tabular-nums ${style.chipClassName}`}
    >
      <Icon aria-hidden className={`size-3 ${style.iconClassName}`} />
      {delta.value}
    </span>
  );
}

/** Inline SVG area chart with a pointermove scrub crosshair: an accent stroke
 * line, an accent-tint fill gradient down to the baseline, a hairline that
 * tracks the pointer, and a mono value bubble showing the hovered point. */
function InsightChart({ series, unit }: { series: number[]; unit: string }) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = pointsFromSeries(series, CHART_WIDTH, CHART_HEIGHT);
  const linePath = pathFromSeries(series, CHART_WIDTH, CHART_HEIGHT);
  const areaPath =
    linePath === ''
      ? ''
      : `${linePath} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`;

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const index = indexFromOffsetX(offsetX, rect.width, series.length);
    setHoverIndex(index === -1 ? null : index);
  }

  const hovered = hoverIndex === null ? null : points[hoverIndex];
  const hoveredValue = hoverIndex === null ? null : series[hoverIndex];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="text-primary block h-24 w-full"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setHoverIndex(null);
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {areaPath !== '' && (
          <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        )}
        {linePath !== '' && (
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {hovered && (
          <line
            x1={hovered.x}
            y1={0}
            x2={hovered.x}
            y2={CHART_HEIGHT}
            stroke="var(--border)"
            strokeWidth={1}
          />
        )}
        {hovered && (
          <circle
            cx={hovered.x}
            cy={hovered.y}
            r={2.5}
            fill="var(--accent)"
            stroke="var(--surface-card)"
            strokeWidth={1.5}
          />
        )}
      </svg>
      {hovered && hoveredValue !== undefined && (
        <span
          className="bg-foreground text-background rounded-chip pointer-events-none absolute top-0 -translate-x-1/2 -translate-y-full px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums"
          style={{
            left: `${String((hovered.x / CHART_WIDTH) * 100)}%`,
          }}
        >
          {hoveredValue} {unit}
        </span>
      )}
    </div>
  );
}

/** Paged agent insight card: title and muted summary, a direction-tinted delta
 * chip, an inline area chart with scrub crosshair, and pager dots when there's
 * more than one insight. Matches the showcase's "Insight Cards" primitive.
 * Paging is fully controlled — the caller owns `page` and receives index
 * changes via `onPageChange`. */
export function InsightCard({
  title,
  summary,
  series,
  unit,
  delta,
  page,
  pageCount,
  onPageChange,
}: InsightCardProps) {
  return (
    <div className="bg-card rounded-card shadow-card w-full max-w-sm overflow-hidden p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-[13px] font-semibold text-pretty">
            {title}
          </p>
          <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
            {summary}
          </p>
        </div>
        <DeltaChip delta={delta} />
      </div>

      <div className="bg-surface-inset rounded-control shadow-hairline mt-3 overflow-hidden">
        <div className="border-border flex items-center justify-between border-b px-2.5 py-1.5">
          <span className="text-muted-foreground text-[11px] tabular-nums">
            Trend snapshot
          </span>
          <span className="text-muted-foreground font-mono text-[10.5px] tabular-nums">
            {unit}
          </span>
        </div>
        <InsightChart series={series} unit={unit} />
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {Array.from({ length: pageCount }, (_, index) => (
            <button
              key={index}
              type="button"
              aria-label={`Go to insight ${String(index + 1)}`}
              aria-current={index === page}
              onClick={() => {
                onPageChange(index);
              }}
              className={`ease-out-expo size-1.5 rounded-full transition-colors duration-150 ${
                index === page
                  ? 'bg-primary'
                  : 'bg-surface-inset shadow-hairline'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
