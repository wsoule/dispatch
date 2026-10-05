import { memo } from 'react';

import type { FlightPlan } from './flightPlan';
import { cn } from '@/lib/utils';

// More waves than this share segments, so a deep plan never outgrows a row.
const MAX_SEGMENTS = 8;

interface Segment {
  done: number;
  running: number;
  total: number;
  current: boolean;
}

// Folds the waves into at most MAX_SEGMENTS segments, summing the tallies of the waves
// each segment covers.
function segmentsOf(plan: FlightPlan): Segment[] {
  const per = Math.max(1, Math.ceil(plan.waves.length / MAX_SEGMENTS));
  const out: Segment[] = [];
  for (let i = 0; i < plan.waves.length; i += per) {
    const covered = plan.waves.slice(i, i + per);
    out.push({
      done: covered.reduce((sum, w) => sum + w.done, 0),
      running: covered.reduce((sum, w) => sum + w.running, 0),
      total: covered.reduce((sum, w) => sum + w.total, 0),
      current: covered.some((w) => w.index === plan.currentWave),
    });
  }
  return out;
}

// One wave: landed fill, then the running share, on a hairline track.
function WaveSegment({ segment }: { segment: Segment }) {
  const donePct =
    segment.total === 0 ? 0 : (segment.done / segment.total) * 100;
  const runPct =
    segment.total === 0 ? 0 : (segment.running / segment.total) * 100;
  return (
    <span
      data-slot="flight-wave"
      data-current={segment.current || undefined}
      className={cn(
        'relative h-1.5 w-3.5 overflow-hidden rounded-[2px] bg-(--border-strong)',
        segment.current &&
          'outline-[0.5px] outline-offset-1 outline-(--state-working-fg)'
      )}
    >
      <span
        className="absolute inset-y-0 left-0 bg-(--status-done)"
        style={{ width: `${donePct}%` }}
      />
      <span
        className="absolute inset-y-0 bg-(--state-working-fg)"
        style={{ left: `${donePct}%`, width: `${runPct}%` }}
      />
    </span>
  );
}

/**
 * The mini Flight Plan: a container's fan-out at row height. One segment per wave — landed
 * in the done hue, running in the working hue, the wave being worked outlined — then `Wave
 * 2/3`, the running count, and one dot per agent slot (filled while in use). Pure display
 * over `buildFlightPlan`; the full Flight Plan reads the same model.
 */
export const FlightPlanMini = memo(function FlightPlanMini({
  plan,
  className,
}: {
  plan: FlightPlan;
  className?: string;
}) {
  const waveCount = plan.waves.length;
  const waveLabel =
    plan.currentWave === null
      ? 'All landed'
      : `Wave ${plan.currentWave + 1}/${waveCount}`;
  const slotTotal = plan.slots.total;
  const summary = [
    plan.currentWave === null
      ? 'every wave landed'
      : `wave ${plan.currentWave + 1} of ${waveCount}`,
    `${plan.running} running`,
    ...(slotTotal === null
      ? []
      : [
          `${Math.min(plan.slots.used, slotTotal)} of ${slotTotal} slots in use`,
        ]),
  ].join(', ');
  return (
    <span
      role="img"
      aria-label={summary}
      data-slot="flight-plan-mini"
      className={cn(
        'font-book text-muted-foreground inline-flex shrink-0 items-center gap-2 text-[12px] tabular-nums',
        className
      )}
    >
      <span aria-hidden className="flex items-center gap-[3px]">
        {segmentsOf(plan).map((segment, i) => (
          <WaveSegment key={i} segment={segment} />
        ))}
      </span>
      <span aria-hidden>{waveLabel}</span>
      {plan.running > 0 && (
        <span aria-hidden className="text-(--state-working-fg)">
          {plan.running} running
        </span>
      )}
      {slotTotal !== null && slotTotal > 0 && (
        <span
          aria-hidden
          data-slot="flight-slots"
          className="flex items-center gap-[3px]"
        >
          {Array.from({ length: slotTotal }, (_, i) => (
            <span
              key={i}
              className={cn(
                'size-1.5 rounded-full',
                i < plan.slots.used
                  ? 'bg-(--state-working-fg)'
                  : 'border-[0.5px] border-(--text-muted)'
              )}
            />
          ))}
        </span>
      )}
    </span>
  );
});
