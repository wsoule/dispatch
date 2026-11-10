import { cx } from '@dispatch/ui';
import { memo } from 'react';

import type { FlightPlan } from './flightPlan';
import styles from './FlightPlanMini.module.css';

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

// One wave: the landed share in the neutral done fill, then the running share in the
// info (in progress) hue, on a soft track. The wave being worked wears an info outline.
function WaveSegment({ segment }: { segment: Segment }) {
  const donePct =
    segment.total === 0 ? 0 : (segment.done / segment.total) * 100;
  const runPct =
    segment.total === 0 ? 0 : (segment.running / segment.total) * 100;
  return (
    <span
      data-slot="flight-wave"
      data-current={segment.current || undefined}
      data-tone={segment.current ? 'info' : undefined}
      className={styles.wave}
    >
      <span className={styles.landed} style={{ width: `${donePct}%` }} />
      <span
        data-tone="info"
        className={styles.running}
        style={{ left: `${donePct}%`, width: `${runPct}%` }}
      />
    </span>
  );
}

/**
 * The mini Flight Plan: a container's fan-out at row height. One segment per wave — landed
 * in the neutral done fill, running in the info hue, the wave being worked outlined in
 * info — then `Wave 2/3`, the running count in info, and one dot per agent slot (filled
 * while in use, a ring while free). Pure display over `buildFlightPlan`; the full Flight
 * Plan reads the same model. The parts are decorative: the `role="img"` name says it all.
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
      className={cx(styles.mini, className)}
    >
      <span aria-hidden className={styles.waves}>
        {segmentsOf(plan).map((segment, i) => (
          <WaveSegment key={i} segment={segment} />
        ))}
      </span>
      <span aria-hidden>{waveLabel}</span>
      {plan.running > 0 && (
        <span aria-hidden className="toneText" data-tone="info">
          {plan.running} running
        </span>
      )}
      {slotTotal !== null && slotTotal > 0 && (
        <span aria-hidden data-slot="flight-slots" className={styles.slots}>
          {Array.from({ length: slotTotal }, (_, i) => (
            <span
              key={i}
              data-tone={i < plan.slots.used ? 'info' : undefined}
              className={styles.slot}
            />
          ))}
        </span>
      )}
    </span>
  );
});
