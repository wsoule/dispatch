import { Button, ProgressRule, type StatCell, StatsStrip } from '@dispatch/ui';
import { Pause, Play } from 'lucide-react';
import { memo } from 'react';

import type { LiveCeilings } from '../../lib/liveSpend';
import { formatUsd } from '../../lib/milestoneSession';
import type { LiveTotals } from './liveBandModel';
import styles from './LiveHeader.module.css';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** The spend cell's short value and its note, from the parts that exist. */
interface LiveSpend {
  value: string;
  note: string;
}

// What the fan-outs' settled spend is measured against: `of $60 ceilings`, or no ceiling.
function ceilingNote(ceilings: LiveCeilings): string {
  return ceilings.ceilingUsd === null
    ? 'in fan-outs, no ceiling'
    : `of ${formatUsd(ceilings.ceilingUsd)} ceilings`;
}

// Today's spend as the cell's value with "today" and the fan-outs' ceilings as its note
// (`$4.20` · `today · $8.10 of $60 ceilings`), else the ceilings alone (`$8.10` · `of $60
// ceilings`), or null when there is neither. Only the short amount is the value; the
// sentence is the note, which the compact strip sets inline after it in the quiet type.
function liveSpend(
  today: number | null,
  ceilings: LiveCeilings | null
): LiveSpend | null {
  if (today !== null) {
    return {
      value: formatUsd(today),
      note:
        ceilings === null
          ? 'today'
          : `today · ${formatUsd(ceilings.settledUsd)} ${ceilingNote(ceilings)}`,
    };
  }
  return ceilings === null
    ? null
    : { value: formatUsd(ceilings.settledUsd), note: ceilingNote(ceilings) };
}

// The agent slots across every live fan-out: a ProgressRule meter (warning once every
// slot is taken), else a quiet "No fan-out live".
function slotsCell(slots: LiveTotals['slots']): StatCell {
  if (slots.total <= 0) {
    return {
      id: 'slots',
      label: 'Slots',
      value: 'None',
      note: 'No fan-out live',
      tone: 'muted',
    };
  }
  const used = Math.min(slots.used, slots.total);
  return {
    id: 'slots',
    label: 'Slots',
    value: (
      <ProgressRule
        data-slot="live-slots"
        done={used}
        total={slots.total}
        aria-label="Agent slots"
        valueText={`${used} of ${slots.total} slots in use`}
        tone={slots.used >= slots.total ? 'warning' : 'default'}
      />
    ),
  };
}

// Every cell of the strip, in reading order: slots, running, queued, waiting on a
// teammate, landing, then the spend when there is any. A count takes its status tone
// only while it is above zero (blue running and landing, amber blocked behind a teammate).
function headerCells(totals: LiveTotals, spend: LiveSpend | null): StatCell[] {
  const cells: StatCell[] = [
    slotsCell(totals.slots),
    {
      id: 'running',
      'data-slot': 'live-running',
      label: 'Running',
      value: totals.running,
      tone: totals.running > 0 ? 'info' : 'default',
    },
    {
      id: 'queued',
      'data-slot': 'live-queued',
      label: 'Queued',
      value: totals.queued,
      title: 'Starts on its own as a fan-out slot frees',
    },
    {
      id: 'teammate',
      'data-slot': 'live-teammate',
      label: 'Waiting on teammates',
      value: totals.waitingOnTeammate,
      tone: totals.waitingOnTeammate > 0 ? 'warning' : 'default',
      title: "Blocked behind a teammate's issue, which no fan-out starts",
    },
    {
      id: 'landing',
      'data-slot': 'live-landing',
      label: 'Landing',
      value: totals.landing,
      tone: totals.landing > 0 ? 'info' : 'default',
    },
  ];
  if (spend !== null) {
    cells.push({
      id: 'spend',
      'data-slot': 'live-spend',
      label: 'Spend',
      value: spend.value,
      note: spend.note,
    });
  }
  return cells;
}

interface LiveHeaderProps {
  totals: LiveTotals;
  spendToday: number | null;
  ceilings: LiveCeilings | null;
  /** Fan-outs filling slots now: what Pause all stops. */
  active: number;
  /** Fan-outs someone paused: what Resume all restarts. */
  resumable: number;
  /** Fan-outs a ceiling paused, which only a raised ceiling resumes. */
  capped: number;
  busy: boolean;
  onPauseAll: () => void;
  onResumeAll: () => void;
}

/**
 * The Live view's strip: a library StatsStrip of the agent slots across every live
 * fan-out, what is running, queued, waiting on a teammate and landing, and today's spend
 * against the fan-outs' ceilings; then one control for the whole fleet on the right —
 * Pause all while anything is filling slots, else Resume all for what someone paused.
 * The strip is the compact variant (owner decision 2026-11-03): one 26px row of inline
 * cells at desktop widths, whole cells wrapping onto more rows on a narrow column, so the
 * bands keep the height the old panel took.
 */
export const LiveHeader = memo(function LiveHeader({
  totals,
  spendToday,
  ceilings,
  active,
  resumable,
  capped,
  busy,
  onPauseAll,
  onResumeAll,
}: LiveHeaderProps) {
  const spend = liveSpend(spendToday, ceilings);
  return (
    <div className={styles.header}>
      <div className={styles.strip}>
        <StatsStrip
          variant="compact"
          data-slot="live-header"
          label="Live"
          cells={headerCells(totals, spend)}
        />
      </div>
      {active > 0 ? (
        <div className={styles.controls}>
          <Button
            variant="secondary"
            size="sm"
            data-slot="live-pause-all"
            disabled={busy}
            icon={<Pause {...ICON} />}
            onClick={onPauseAll}
          >
            Pause all
          </Button>
        </div>
      ) : resumable > 0 ? (
        <div className={styles.controls}>
          <Button
            variant="secondary"
            size="sm"
            data-slot="live-resume-all"
            disabled={busy}
            icon={<Play {...ICON} />}
            onClick={onResumeAll}
            title={
              capped > 0
                ? `${capped} paused on a ceiling stay paused: raise it on the band`
                : undefined
            }
          >
            Resume all
          </Button>
        </div>
      ) : null}
    </div>
  );
});
