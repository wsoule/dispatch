import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isCompletedStatus } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, MilestoneSession } from '@dispatch/client';
import { Button, Chip, ProgressPie } from '@dispatch/ui';
import {
  ChevronsUp,
  GitMerge,
  Pause,
  Play,
  Square,
  Target,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import {
  pausedReasonLabel,
  PHASE_CHIP_ORDER,
  PHASE_LABEL,
  phaseCounts,
  phaseTone,
  rulingsWaiting,
  spendPillLabel,
  spendTitle,
  spendTone,
  waveSteps,
} from '../../lib/milestoneSession';
import { StepStrip } from '../status/StepStrip';
import styles from './FanoutControls.module.css';

const ICON = { size: 12, strokeWidth: 1.8 } as const;

/** A verb in the row: a small secondary button with its leading icon. */
function Verb({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={icon}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** A pill with a hook for tests and a hover title: a status chip in a wrapper that carries
    both, since Chip takes neither a data attribute nor a role. */
function Pill({
  slot,
  title,
  tone,
  role,
  children,
}: {
  slot?: string;
  title?: string;
  tone: 'info' | 'warning' | 'danger';
  role?: 'alert';
  children: ReactNode;
}) {
  return (
    <span data-slot={slot} title={title} role={role} className={styles.pill}>
      <Chip tone={tone}>{children}</Chip>
    </span>
  );
}

export interface FanoutControlsProps {
  milestone: TaskListItem;
  /** The project's statuses, which say the milestone has landed. */
  model: StatusModel;
  /** `undefined` until the milestone's progress fetch resolves — the verbs still render, read
   * as "no session". */
  progress: MilestoneProgress | undefined;
  /** Children landed or dropped, over every child — the `◔ done/total` glyph, shown even
   * at `0/0`. Callers count from whichever source they trust (the group's docs on the
   * milestones page, progress children on the board); `undefined` while that source has
   * not resolved hides the glyph and keeps Send agents… on offer. */
  count?: { done: number; total: number };
  /** Every child done or cancelled and the milestone not yet landed — the caller applies the
   * server's rule; Land replaces Send agents… while it holds. */
  landable: boolean;
  /** The board lane's concurrency `SelectPill`; rendered before Send agents… in the
   * no-session state only, since a running session chose its concurrency already. */
  concurrencyPicker?: ReactNode;
  /** Pills and buttons after the glyph and before the state's own controls — the
   * milestone health pill, the board's id chip and graph button. */
  children?: ReactNode;
  /** Send agents…: opens the fan-out dialog, or dispatches straight away when it returns
   * a promise (the board's direct path). */
  onSendAgents: (milestoneId: string) => void | Promise<void>;
  onPause?: (milestoneId: string) => Promise<void>;
  onResume?: (milestoneId: string) => Promise<void>;
  /** Reopens the dialog pre-filled from the paused session. */
  onRaiseCeiling?: (milestoneId: string) => void;
  onStop: (milestoneId: string) => Promise<void>;
  onLand?: (milestoneId: string) => Promise<void>;
  onOpenMilestone: (milestoneId: string) => void;
  /** The trailing Open button; the board turns it off since its id chip opens the milestone. */
  showOpen?: boolean;
  /** An active session's phase chips; the Flight Plan turns them off since its header
   * counts the same children. */
  phases?: boolean;
  /** An active session's wave strip; the Live view turns it off since its band draws the
   * same waves. */
  waves?: boolean;
}

/** No session, or one that has run its course — the caller's own live-run pill speaks
 * for the milestone, and the verbs offer a fresh fan-out. */
export function sessionIdle(session: MilestoneSession | null): boolean {
  return (
    session === null ||
    session.state === 'complete' ||
    session.state === 'stopped'
  );
}

/**
 * The fan-out controls one milestone header carries — rendered in the board's
 * `MilestoneLaneHeader` `actions` slot and in the Flight plan and Live heads, so they
 * cannot drift. Left to right by session state: `◔ done/total`, the caller's pills, then
 *
 * - no session (or a finished one): Send agents… — or Land once every child is done, and
 *   nothing for a landed milestone or one with no children to send;
 * - active: phase chips, the spend pill against its ceiling, `Waiting on N rulings` when
 *   nothing is live and capped loops remain, the wave strip, Pause, Stop;
 * - paused: the spend pill, why it paused, Resume, Raise ceiling…, Stop;
 *
 * and an Open button last. Header only — no bar under it, no card. Every async verb runs
 * through one busy flag; a failure shows as a red pill in the same row.
 */
export function FanoutControls({
  milestone,
  model,
  progress,
  count,
  landable,
  concurrencyPicker,
  children,
  onSendAgents,
  onPause,
  onResume,
  onRaiseCeiling,
  onStop,
  onLand,
  onOpenMilestone,
  showOpen = true,
  phases = true,
  waves = true,
}: FanoutControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const milestoneId = milestone.meta.id;
  const session = progress?.session ?? null;
  const active = session?.state === 'active';
  const paused = session?.state === 'paused';
  const progressChildren = progress?.children ?? [];

  // One verb at a time; a rejected handler's message replaces the verbs' error pill.
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Settled spend against its ceiling, shown while a session is active or paused. The hover
  // text names the near-ceiling state the amber dot conveys, so it reads without colour.
  let spendPill: ReactNode = null;
  if (progress !== undefined) {
    const spend = progress.spend;
    const nearCeiling = spendTone(spend) === 'warning';
    spendPill = (
      <Pill
        slot="spend-pill"
        tone={nearCeiling ? 'warning' : 'info'}
        title={
          nearCeiling
            ? `${spendTitle(spend)} · near ceiling`
            : spendTitle(spend)
        }
      >
        {spendPillLabel(spend)}
      </Pill>
    );
  }

  let controls: ReactNode;
  if (active && progress !== undefined) {
    // Counting nothing leaves no chips, for a caller that shows its own counts.
    const counts = phaseCounts(phases ? progressChildren : []);
    const spend = progress.spend;
    const rulings = rulingsWaiting(progressChildren);
    controls = (
      <>
        {PHASE_CHIP_ORDER.filter((phase) => counts[phase] > 0).map((phase) => (
          <span
            key={phase}
            data-slot="phase-chip"
            data-phase={phase}
            data-tone={phaseTone(phase) ?? undefined}
            className={styles.phase}
          >
            <span className={styles.count}>{counts[phase]}</span>
            {PHASE_LABEL[phase]}
          </span>
        ))}
        {spendPill}
        {spend.liveCount === 0 && rulings > 0 && (
          <Pill tone="warning">
            Waiting on {rulings} ruling{rulings === 1 ? '' : 's'}
          </Pill>
        )}
        {waves && progress.waves.length > 1 && (
          <StepStrip
            steps={waveSteps(progress.waves)}
            className={styles.waves}
          />
        )}
        {onPause !== undefined && (
          <Verb
            disabled={busy}
            onClick={() => void run(() => onPause(milestoneId))}
            icon={<Pause {...ICON} />}
          >
            Pause
          </Verb>
        )}
        <Verb
          disabled={busy}
          onClick={() => void run(() => onStop(milestoneId))}
          icon={<Square {...ICON} />}
        >
          Stop
        </Verb>
      </>
    );
  } else if (paused && session !== null) {
    // The ceiling that tripped stays on screen next to Raise ceiling….
    controls = (
      <>
        {spendPill}
        <Pill slot="paused-pill" tone="warning" title={session.pausedDetail}>
          {session.pausedReason === undefined
            ? 'Paused'
            : pausedReasonLabel(session.pausedReason)}
        </Pill>
        {onResume !== undefined && (
          <Verb
            disabled={busy}
            onClick={() => void run(() => onResume(milestoneId))}
            icon={<Play {...ICON} />}
          >
            Resume
          </Verb>
        )}
        {onRaiseCeiling !== undefined && (
          <Verb
            disabled={busy}
            onClick={() => onRaiseCeiling(milestoneId)}
            icon={<ChevronsUp {...ICON} />}
          >
            Raise ceiling…
          </Verb>
        )}
        <Verb
          disabled={busy}
          onClick={() => void run(() => onStop(milestoneId))}
          icon={<Square {...ICON} />}
        >
          Stop
        </Verb>
      </>
    );
  } else if (landable && onLand !== undefined) {
    controls = (
      <Verb
        disabled={busy}
        onClick={() => void run(() => onLand(milestoneId))}
        icon={<GitMerge {...ICON} />}
      >
        Land
      </Verb>
    );
  } else if (
    isCompletedStatus(milestone.meta.status, model) ||
    count?.total === 0
  ) {
    // Nothing to send: a landed milestone is done, and an empty milestone would open a dialog
    // whose confirm is disabled.
    controls = null;
  } else {
    controls = (
      <>
        {concurrencyPicker}
        <Verb
          disabled={busy}
          onClick={() => {
            // Opening the dialog is synchronous and never busy; only a direct dispatch is.
            const result = onSendAgents(milestoneId);
            if (result instanceof Promise) void run(() => result);
          }}
          icon={<Zap {...ICON} />}
        >
          Send agents…
        </Verb>
      </>
    );
  }

  return (
    <>
      {count !== undefined && (
        <span
          data-slot="milestone-progress"
          aria-label={`${count.done} of ${count.total} landed`}
          className={styles.progress}
        >
          {/* Decorative: the span's label and the printed count say it. */}
          <ProgressPie done={count.done} total={count.total} label="" />
          {count.done}/{count.total}
        </span>
      )}
      {children}
      {controls}
      {error !== null && (
        <Pill role="alert" tone="danger" title={error}>
          {error}
        </Pill>
      )}
      {showOpen && (
        <Button
          variant="quiet"
          size="sm"
          icon={<Target size={14} strokeWidth={1.8} />}
          aria-label={`Open ${milestone.meta.title}`}
          title={`Open ${milestone.meta.title}`}
          onClick={() => onOpenMilestone(milestoneId)}
        />
      )}
    </>
  );
}
