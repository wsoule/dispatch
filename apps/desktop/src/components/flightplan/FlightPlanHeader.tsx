import { ProgressRule, type StatCell, StatsStrip } from '@dispatch/ui';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import type { SpendCellWords } from '../../lib/milestoneSession';
import { type Step, StepStrip } from '../status/StepStrip';
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
  /** The plan's own fan-out spend while its session is active or paused, else absent.
   * It replaces the controls' spend pill, so the end of the row holds only the verbs. */
  spend?: SpendCellWords | null;
  /** The plan's own fan-out session is paused: its spend then leads the strip, beside
   * nothing but the paused verbs (Resume, Raise ceiling…, Stop). */
  paused?: boolean;
  /** The plan's own fan-out waves while its session is active and has more than one,
   * else absent: the controls' wave strip, as a cell. */
  waves?: readonly Step[] | null;
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
//
// `picker` is the plan's own slots control (FlightPlanView's Menu trigger), drawn right
// after the meter in the same cell: the meter already prints the slots' total, so the
// control needs no words of its own on screen, only its accessible name.
function runningCells(stats: FlightHeaderStats, picker: ReactNode): StatCell[] {
  const { slots, running } = stats;
  const tone = running > 0 ? 'info' : 'default';
  if (slots.total === null) {
    return [
      {
        id: 'running',
        'data-slot': 'flight-stat',
        label: 'Running',
        value: withPicker(running, picker),
        tone,
        title: 'Not fanning out, so no agent slots are held',
      },
    ];
  }
  const used = Math.min(slots.used, slots.total);
  const slotsHint = `${used} of ${slots.total} agent slots in use`;
  const meter = withPicker(slotsMeter(used, slots.total), picker);
  // The meter's cell keeps the id `slots` (its React key) whether it reads Running or
  // Slots, so picking fewer slots than the runs in flight, which splits the count into a
  // cell of its own, keeps the <li> that holds the picker, and with it the picker's focus.
  if (running <= slots.total) {
    return [
      {
        id: 'slots',
        'data-slot': 'flight-stat',
        label: 'Running',
        value: meter,
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
      value: meter,
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

// A cell's value with the slots picker after it, or the value alone with no picker.
function withPicker(value: ReactNode, picker: ReactNode): ReactNode {
  if (picker === undefined || picker === null || picker === false) return value;
  return (
    <span className={styles.slots}>
      {value}
      {picker}
    </span>
  );
}

// The fan-out's spend cell: what it has spent against its ceiling, a warning near it
// said by a triangle and in words for a screen reader as well as by the tone. Null while
// the plan's own session is neither active nor paused.
function spendCell(spend: SpendCellWords | null | undefined): StatCell | null {
  if (spend === undefined || spend === null) return null;
  return {
    id: 'spend',
    'data-slot': 'flight-spend',
    label: 'Spend',
    icon: spend.nearCeiling ? (
      <TriangleAlert size={12} strokeWidth={2} />
    ) : undefined,
    value: spend.nearCeiling ? (
      <>
        {spend.value}
        <span className="srOnly">, near its ceiling</span>
      </>
    ) : (
      spend.value
    ),
    note: spend.note,
    tone: spend.nearCeiling ? 'warning' : 'default',
    title: spend.title,
    // The title already says the note's amounts: the hint says it alone.
    hint: spend.title,
  };
}

// The fan-out's waves as the step strip, each wave named for a screen reader, or null
// with one wave or none.
function wavesCell(waves: readonly Step[] | null | undefined): StatCell | null {
  if (waves === undefined || waves === null || waves.length <= 1) return null;
  return {
    id: 'waves',
    'data-slot': 'flight-waves',
    label: 'Waves',
    value: <StepStrip steps={waves} className={styles.waves} />,
    title: waves.map((step) => `${step.name}: ${step.status}`).join(', '),
  };
}

// The cells in reading order once the spend has its place. A calm spend comes after the
// counts, before the waves, the least urgent at the end where the strip's fade hides
// first. A spend that needs reading is never left there: a paused session's spend leads
// the strip (the paused verbs leave it its narrowest, and the amount is what Raise
// ceiling… asks about), and an active session's spend near its ceiling comes straight
// after the running cell(s), on screen at every width without moving the cell that holds
// the slots picker (moving that <li> would drop the picker's focus).
function placeSpend(
  running: StatCell[],
  rest: StatCell[],
  spend: StatCell | null,
  waves: StatCell | null,
  stats: FlightHeaderStats
): StatCell[] {
  const tail = waves === null ? [] : [waves];
  if (spend === null) return [...running, ...rest, ...tail];
  if (stats.paused === true) return [spend, ...running, ...rest, ...tail];
  if (stats.spend?.nearCeiling === true) {
    return [...running, spend, ...rest, ...tail];
  }
  return [...running, ...rest, spend, ...tail];
}

// Every cell of the strip, in reading order. With no fan-out: running, ready, landed, then
// the critical path. Fanning out, the cells that answer "when is it done" come first —
// running (with the slots meter and its picker), the ETA, the critical path, then queued
// and landed, then the fan-out's spend and waves — so a column too narrow for them all
// hides the least urgent behind the strip's fade; a spend that warns or a paused session's
// spend moves forward instead (`placeSpend`). The critical path's remaining time is its
// note unless the ETA's "left" says the very same duration, and is always in its title
// too. While fanning out the notes go into the cells' hints (`FlightPlanHeader`), so
// each noted cell's `hint` is a sentence that says its note's facts.
function headerCells(stats: FlightHeaderStats, picker: ReactNode): StatCell[] {
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
    const etaBasis = `critical path, or the remaining work over the slots when that is longer, ${paceNote}`;
    timing.push({
      id: 'eta',
      'data-slot': 'flight-eta',
      label: 'ETA',
      value: formatEta(eta.at, eta.at - eta.ms),
      note: `${formatDuration(eta.ms)} left`,
      title: `The ${etaBasis}`,
      hint: `${formatDuration(eta.ms)} left, by the ${etaBasis}`,
    });
  }
  if (critical.count > 0) {
    const left = formatDuration(critical.ms);
    // The ETA is the longer of the critical path and the remaining work over the slots, so
    // its "left" can be a different, longer time: the path's own time then stays on screen.
    const sameAsEta = showEta && formatDuration(eta.ms) === left;
    const title = `The longest chain still to land, ${left} of work ${paceNote}`;
    timing.push({
      id: 'critical',
      'data-slot': 'flight-critical-stat',
      label: 'Critical path',
      // The accent swatch is the legend for the highlighter under the canvas's edges.
      icon: <span className={styles.criticalSwatch} />,
      value: critical.count,
      ...(sameAsEta ? {} : { note: left }),
      title,
      // The title says the note's time: the hint says it alone.
      hint: title,
    });
  }
  return placeSpend(
    runningCells(stats, picker),
    fanningOut ? [...timing, ...counts] : [...counts, ...timing],
    spendCell(stats.spend),
    wavesCell(stats.waves),
    stats
  );
}

/**
 * The Flight Plan's header: a library StatsStrip of what is running (with the agent slots
 * meter and, for the plan's own live fan-out, the `slotsPicker` that changes its slots),
 * the ETA and the critical path (its accent swatch is the legend for the highlighter on
 * the canvas), queued and landed, the fan-out's spend and waves, then the caller's fan-out
 * verbs as the strip's `end`, at the end of the same row. The picker, the spend and the
 * waves live in cells rather than beside the verbs, so the verbs take as little of the row
 * as they can and the cells keep the rest; a spend near its ceiling, or a paused session's,
 * moves to the front of the strip so it stays on screen. The strip is the compact variant (owner
 * decision 2026-11-03): one 26px row at every width, the cells scrolling sideways inside
 * the strip when the column is too narrow, so Plan mode and container pages keep their
 * canvas height; the controls drop under it only on a column too narrow for both. While a
 * fan-out runs or is paused (owner decision 2026-11-04) the cells' notes (the ETA's time
 * left, the critical path's, the spend's ceiling) move into their hints, a Tooltip on each
 * of those cells on hover and keyboard focus (the notes stay in the cells' text for a
 * screen reader, and on the row on a touch screen), and the caller draws Pause and Stop
 * icon-only, so more of the cells share the row with the verbs.
 */
export function FlightPlanHeader({
  stats,
  controls,
  slotsPicker,
}: {
  stats: FlightHeaderStats;
  controls: ReactNode;
  slotsPicker?: ReactNode;
}) {
  return (
    <div data-slot="flight-header" className={styles.header}>
      <StatsStrip
        variant="compact"
        label="Flight plan"
        notes={stats.slots.total === null ? 'inline' : 'hint'}
        cells={headerCells(stats, slotsPicker)}
        end={controls}
      />
    </div>
  );
}
