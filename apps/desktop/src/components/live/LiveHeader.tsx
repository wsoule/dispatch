import { Pause, Play } from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { formatUsd } from '../../lib/epicSession';
import type { LiveCeilings } from '../shell/FrameStatusStrip';
import type { LiveTotals } from './liveBandModel';
import { PillButton } from '@/ui/ai/pill';

// A number and its word, the number bright — the Flight Plan header's reading.
function Stat({
  value,
  label,
  dot,
  title,
  slot,
}: {
  value: ReactNode;
  label: string;
  dot?: string;
  title?: string;
  slot: string;
}) {
  return (
    <span
      data-slot={slot}
      title={title}
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

// Slots across every live fan-out: a hairline that fills as agents take them.
function SlotBar({ used, total }: { used: number; total: number }) {
  const pct = total === 0 ? 0 : Math.min(100, (used / total) * 100);
  return (
    <span
      data-slot="live-slots"
      role="img"
      aria-label={`${Math.min(used, total)} of ${total} slots in use`}
      className="flex shrink-0 items-center gap-1.5 text-[12px]"
    >
      <span
        aria-hidden
        className="relative h-1.5 w-16 overflow-hidden rounded-full bg-(--border-strong)"
      >
        <span
          className="bg-state-working absolute inset-y-0 left-0 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
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

// `$4.20 today · $8.10 of $60 ceilings`, the parts that exist.
function liveSpendLabel(
  today: number | null,
  ceilings: LiveCeilings | null
): string | null {
  const parts: string[] = [];
  if (today !== null) parts.push(`${formatUsd(today)} today`);
  if (ceilings !== null) {
    const settled = formatUsd(ceilings.settledUsd);
    parts.push(
      ceilings.ceilingUsd === null
        ? `${settled} in fan-outs, no ceiling`
        : `${settled} of ${formatUsd(ceilings.ceilingUsd)} ceilings`
    );
  }
  return parts.length === 0 ? null : parts.join(' · ');
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
 * The Live view's strip: slots across every live fan-out, what is running, queued,
 * waiting on a teammate and landing, today's spend against the fan-outs' ceilings, and
 * one control for the whole fleet — Pause all while anything is filling slots, else
 * Resume all for what someone paused.
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
  const spend = liveSpendLabel(spendToday, ceilings);
  return (
    <div
      data-slot="live-header"
      className="shadow-hairline-bottom flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5"
    >
      {totals.slots.total > 0 ? (
        <SlotBar used={totals.slots.used} total={totals.slots.total} />
      ) : (
        <span className="shrink-0 text-[12px] text-(--text-muted)">
          No fan-out live
        </span>
      )}
      <Stat
        slot="live-running"
        value={totals.running}
        label="running"
        dot="var(--state-working-fg)"
      />
      <Stat
        slot="live-queued"
        value={totals.queued}
        label="queued"
        title="Starts on its own as a fan-out slot frees"
      />
      <Stat
        slot="live-teammate"
        value={totals.waitingOnTeammate}
        label="waiting on teammates"
        dot="var(--status-progress)"
        title="Blocked behind a teammate's issue, which no fan-out starts"
      />
      <Stat
        slot="live-landing"
        value={totals.landing}
        label="landing"
        dot="var(--state-landing-fg)"
      />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {spend !== null && (
          <span
            data-slot="live-spend"
            className="font-book text-[12px] text-(--text-muted) tabular-nums"
          >
            {spend}
          </span>
        )}
        {active > 0 ? (
          <PillButton
            data-slot="live-pause-all"
            disabled={busy}
            onClick={onPauseAll}
          >
            <Pause className="size-3" />
            Pause all
          </PillButton>
        ) : resumable > 0 ? (
          <PillButton
            data-slot="live-resume-all"
            disabled={busy}
            onClick={onResumeAll}
            title={
              capped > 0
                ? `${capped} paused on a ceiling stay paused: raise it on the band`
                : undefined
            }
          >
            <Play className="size-3" />
            Resume all
          </PillButton>
        ) : null}
      </div>
    </div>
  );
});
