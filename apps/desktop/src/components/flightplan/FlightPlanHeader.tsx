import { ProgressRule, type StatCell, StatsStrip } from '@dispatch/ui';
import type { ReactNode } from 'react';

import { formatDuration, formatEta } from './criticalPath';
import styles from './FlightPlanHeader.module.css';

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

// The agent slots cell: a ProgressRule meter while a fan-out holds slots (warning once
// every slot is taken), else a quiet "Not fanning out".
function slotsCell(slots: FlightHeaderStats['slots']): StatCell {
  if (slots.total === null) {
    return {
      id: 'slots',
      'data-slot': 'flight-stat',
      label: 'Slots',
      value: 'None',
      note: 'Not fanning out',
      tone: 'muted',
    };
  }
  const used = Math.min(slots.used, slots.total);
  return {
    id: 'slots',
    'data-slot': 'flight-stat',
    label: 'Slots',
    value: (
      <ProgressRule
        data-slot="flight-slots"
        done={used}
        total={slots.total}
        aria-label="Agent slots"
        valueText={`${used} of ${slots.total} slots in use`}
        tone={slots.used >= slots.total ? 'warning' : 'default'}
      />
    ),
  };
}

// Every cell of the strip, in reading order: slots, running, queued (or ready), landed,
// then the critical path and the ETA when there is one to show.
function headerCells(stats: FlightHeaderStats): StatCell[] {
  const { slots, critical, eta, pace } = stats;
  const fanningOut = slots.total !== null;
  const paceNote =
    pace.samples === 0
      ? `assuming ${formatDuration(pace.medianMs).replace('~', '')} a run until more runs finish`
      : `at ${formatDuration(pace.medianMs).replace('~', '')} a run, the median of the last ${pace.samples}`;
  const cells: StatCell[] = [
    slotsCell(slots),
    {
      id: 'running',
      'data-slot': 'flight-stat',
      label: 'Running',
      value: stats.running,
      tone: stats.running > 0 ? 'info' : 'default',
    },
    // Nothing is queued for a fan-out that is not running — only ready.
    {
      id: 'queued',
      'data-slot': 'flight-stat',
      label: fanningOut ? 'Queued' : 'Ready',
      value: stats.queued,
      title: fanningOut
        ? 'Waiting for a free agent slot'
        : 'Free to start, with no blocker ahead',
    },
    {
      id: 'landed',
      'data-slot': 'flight-stat',
      label: 'Landed',
      value: `${stats.done}/${stats.total}`,
    },
  ];
  if (critical.count > 0) {
    cells.push({
      id: 'critical',
      'data-slot': 'flight-critical-stat',
      label: 'Critical path',
      // The accent swatch is the legend for the highlighter under the canvas's edges.
      icon: <span className={styles.criticalSwatch} />,
      value: critical.count,
      note: formatDuration(critical.ms),
      title: `The longest chain still to land, ${paceNote}`,
    });
  }
  if (eta !== null && eta.ms > 0) {
    cells.push({
      id: 'eta',
      'data-slot': 'flight-eta',
      label: 'ETA',
      value: formatEta(eta.at, eta.at - eta.ms),
      note: `${formatDuration(eta.ms)} left`,
      title: `The critical path, or the remaining work over the slots when that is longer, ${paceNote}`,
    });
  }
  return cells;
}

/**
 * The Flight Plan's header: a library StatsStrip of the agent slots meter, what is
 * running, queued and landed, the critical path (its accent swatch is the legend for the
 * highlighter on the canvas) and the ETA, then the caller's fan-out controls as the
 * strip's `end`, at the end of the same row. The strip is the compact variant (owner
 * decision 2026-11-03): one 26px row at every width, the cells scrolling sideways inside
 * the strip when the column is too narrow, so Plan mode and container pages keep their
 * canvas height; the controls drop under it only on a column too narrow for both.
 */
export function FlightPlanHeader({
  stats,
  controls,
}: {
  stats: FlightHeaderStats;
  controls: ReactNode;
}) {
  return (
    <div data-slot="flight-header" className={styles.header}>
      <StatsStrip
        variant="compact"
        label="Flight plan"
        cells={headerCells(stats)}
        end={controls}
      />
    </div>
  );
}
