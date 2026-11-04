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

// The agent slots meter: a ProgressRule of the slots in use, warning once every slot is
// taken. Its name and value text say "agent slots" in full for a screen reader.
function slotsMeter(used: number, total: number): ReactNode {
  return (
    <ProgressRule
      data-slot="flight-slots"
      done={used}
      total={total}
      aria-label="Agent slots"
      valueText={`${used} of ${total} slots in use`}
      tone={used >= total ? 'warning' : 'default'}
    />
  );
}

// The strip's first cells: what runs and, while a fan-out holds slots, how many of them.
// FlightPlanView counts a fan-out's slots in use as the plan's running nodes, so fanning
// out one "Running" cell carries the slots meter (its "1/2" is both) and the header's
// columns stay free for the critical path and the ETA. Only when hand-dispatched runs
// push the running count past the slots does the strip keep a Slots meter and a Running
// count apart, so the meter never hides a run. With no fan-out it is a plain count, and
// "not fanning out" is the cell's hint (Ready and Send agents… say it on screen).
function runningCells(stats: FlightHeaderStats): StatCell[] {
  const { slots, running } = stats;
  const tone = running > 0 ? 'info' : 'default';
  if (slots.total === null) {
    return [
      {
        id: 'running',
        'data-slot': 'flight-stat',
        label: 'Running',
        value: running,
        tone,
        title: 'Not fanning out, so no agent slots are held',
      },
    ];
  }
  const used = Math.min(slots.used, slots.total);
  const slotsHint = `${used} of ${slots.total} agent slots in use`;
  if (running <= slots.total) {
    return [
      {
        id: 'running',
        'data-slot': 'flight-stat',
        label: 'Running',
        value: slotsMeter(used, slots.total),
        tone,
        title: slotsHint,
      },
    ];
  }
  return [
    {
      id: 'slots',
      'data-slot': 'flight-stat',
      label: 'Slots',
      value: slotsMeter(used, slots.total),
      title: slotsHint,
    },
    {
      id: 'running',
      'data-slot': 'flight-stat',
      label: 'Running',
      value: running,
      tone,
    },
  ];
}

// Every cell of the strip, in reading order. With no fan-out: running, ready, landed, then
// the critical path. Fanning out, the cells that answer "when is it done" come first —
// running (with the slots meter), the ETA, the critical path, then queued and landed —
// because the fan-out controls leave the strip too little room at common widths and the
// strip's fade hides the cells at its end. Notes stay short so the cells and the controls
// share the header's row: the critical path's remaining time is its note unless the ETA's
// "left" says the very same duration, and is always in its hint too.
function headerCells(stats: FlightHeaderStats): StatCell[] {
  const { slots, critical, eta, pace } = stats;
  const fanningOut = slots.total !== null;
  const showEta = eta !== null && eta.ms > 0;
  const paceNote =
    pace.samples === 0
      ? `assuming ${formatDuration(pace.medianMs).replace('~', '')} a run until more runs finish`
      : `at ${formatDuration(pace.medianMs).replace('~', '')} a run, the median of the last ${pace.samples}`;
  const counts: StatCell[] = [
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
  const timing: StatCell[] = [];
  if (showEta) {
    timing.push({
      id: 'eta',
      'data-slot': 'flight-eta',
      label: 'ETA',
      value: formatEta(eta.at, eta.at - eta.ms),
      note: `${formatDuration(eta.ms)} left`,
      title: `The critical path, or the remaining work over the slots when that is longer, ${paceNote}`,
    });
  }
  if (critical.count > 0) {
    const left = formatDuration(critical.ms);
    // The ETA is the longer of the critical path and the remaining work over the slots, so
    // its "left" can be a different, longer time: the path's own time then stays on screen.
    const sameAsEta = showEta && formatDuration(eta.ms) === left;
    timing.push({
      id: 'critical',
      'data-slot': 'flight-critical-stat',
      label: 'Critical path',
      // The accent swatch is the legend for the highlighter under the canvas's edges.
      icon: <span className={styles.criticalSwatch} />,
      value: critical.count,
      ...(sameAsEta ? {} : { note: left }),
      title: `The longest chain still to land, ${left} of work ${paceNote}`,
    });
  }
  return fanningOut
    ? [...runningCells(stats), ...timing, ...counts]
    : [...runningCells(stats), ...counts, ...timing];
}

/**
 * The Flight Plan's header: a library StatsStrip of what is running (with the agent slots
 * meter while fanning out), the ETA and the critical path (its accent swatch is the legend
 * for the highlighter on the canvas), queued and landed, then the caller's fan-out controls as the
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
