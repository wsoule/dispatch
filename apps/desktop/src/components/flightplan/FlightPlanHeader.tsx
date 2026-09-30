import type { ReactNode } from 'react';

import { formatDuration, formatEta } from './criticalPath';
import { cn } from '@/lib/utils';

export interface FlightHeaderStats {
  slots: { used: number; total: number | null };
  running: number;
  queued: number;
  done: number;
  total: number;
  /** Unfinished nodes on the critical path, and its remaining time. */
  critical: { count: number; ms: number };
  /** When everything should have landed, or null with nothing fanning out. */
  eta: { at: number; ms: number } | null;
  /** The run length the estimates assume, and how many runs it came from. */
  pace: { medianMs: number; samples: number };
}

// A number and its word, the number bright.
function Stat({
  value,
  label,
  dot,
}: {
  value: ReactNode;
  label: string;
  dot?: string;
}) {
  return (
    <span
      data-slot="flight-stat"
      className="flex shrink-0 items-center gap-1.5 text-[12px]"
    >
      {dot !== undefined && (
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ backgroundColor: dot }}
        />
      )}
      <span className="text-foreground font-medium tabular-nums">{value}</span>
      <span className="text-(--text-muted)">{label}</span>
    </span>
  );
}

// One dot per agent slot, filled while in use — the Cockpit mini's slot meter.
function SlotMeter({ used, total }: { used: number; total: number }) {
  return (
    <span
      data-slot="flight-slots"
      role="img"
      aria-label={`${Math.min(used, total)} of ${total} slots in use`}
      className="flex shrink-0 items-center gap-1.5 text-[12px]"
    >
      <span aria-hidden className="flex items-center gap-[3px]">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-1.5 rounded-full transition-colors duration-300',
              i < used
                ? 'bg-state-working'
                : 'border-[0.5px] border-(--text-muted)'
            )}
          />
        ))}
      </span>
      <span aria-hidden className="text-foreground font-medium tabular-nums">
        {Math.min(used, total)}/{total}
      </span>
      <span aria-hidden className="text-(--text-muted)">
        slots
      </span>
    </span>
  );
}

/**
 * The Flight Plan's header strip: the slot meter, what is running, queued and landed, the
 * critical path (its accent swatch is the legend for the highlighter on the canvas) and
 * the ETA, then the caller's fan-out controls on the right.
 */
export function FlightPlanHeader({
  stats,
  controls,
}: {
  stats: FlightHeaderStats;
  controls: ReactNode;
}) {
  const { slots, critical, eta, pace } = stats;
  const paceNote =
    pace.samples === 0
      ? `assuming ${formatDuration(pace.medianMs).replace('~', '')} a run until more runs finish`
      : `at ${formatDuration(pace.medianMs).replace('~', '')} a run, the median of the last ${pace.samples}`;
  return (
    <div
      data-slot="flight-header"
      className="shadow-hairline-bottom flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5"
    >
      {slots.total === null ? (
        <span className="shrink-0 text-[12px] text-(--text-muted)">
          Not fanning out
        </span>
      ) : (
        <SlotMeter used={slots.used} total={slots.total} />
      )}
      <Stat
        value={stats.running}
        label="running"
        dot="var(--state-working-fg)"
      />
      {/* Nothing is queued for a fan-out that is not running — only ready. */}
      <Stat
        value={stats.queued}
        label={slots.total === null ? 'ready' : 'queued'}
      />
      <Stat value={`${stats.done}/${stats.total}`} label="landed" />
      {critical.count > 0 && (
        <span
          data-slot="flight-critical-stat"
          title={`The longest chain still to land, ${paceNote}`}
          className="flex shrink-0 items-center gap-1.5 text-[12px]"
        >
          <span
            aria-hidden
            className="h-[5px] w-3.5 rounded-full bg-(--accent) opacity-40"
          />
          <span className="text-(--text-muted)">Critical path</span>
          <span className="text-foreground font-medium tabular-nums">
            {critical.count}
          </span>
          <span className="text-(--text-muted) tabular-nums">
            {formatDuration(critical.ms)}
          </span>
        </span>
      )}
      {eta !== null && eta.ms > 0 && (
        <span
          data-slot="flight-eta"
          title={`The critical path, or the remaining work over the slots when that is longer, ${paceNote}`}
          className="flex shrink-0 items-center gap-1.5 text-[12px]"
        >
          <span className="text-(--text-muted)">ETA</span>
          <span className="text-foreground font-medium tabular-nums">
            {formatEta(eta.at, eta.at - eta.ms)}
          </span>
          <span className="text-(--text-muted) tabular-nums">
            {formatDuration(eta.ms)} left
          </span>
        </span>
      )}
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
        {controls}
      </div>
    </div>
  );
}
