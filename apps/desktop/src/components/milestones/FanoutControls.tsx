import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import type {
  MilestonePauseReason,
  MilestoneProgress,
  MilestoneSession,
} from '@dispatch/client';
import {
  Button,
  Chip,
  ConfirmDialog,
  ProgressPie,
  Tooltip,
  useTouchScreen,
} from '@dispatch/ui';
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

import { fanoutVerbs } from '../../lib/fanoutVerbs';
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
/** An icon-only verb's glyph: the library's 14px button icon, alone in its 26px square. */
const ICON_ONLY = { size: 14, strokeWidth: 1.8 } as const;

/** What each verb does, for its hint when it is drawn icon-only. */
const PAUSE_HINT =
  'Pause the fan-out: live runs go on, no new ones start until you resume';
const STOP_HINT =
  'Stop the fan-out for good: live runs go on, no new ones start';
const RAISE_HINT = 'Raise the fan-out’s spend or run ceiling, then resume it';

/** What Resume does after this pause, for its hint when it is drawn icon-only. Resume
    keeps the session's ceilings, so after a ceiling pause the server's next fill pauses
    it again (packages/server/src/orchestrator/milestone.ts: a run ceiling at once, a
    spend ceiling once nothing is live) and no new run starts: the hint says so and
    points at Raise ceiling…, rather than promising runs. */
function resumeHint(reason: MilestonePauseReason | undefined): string {
  switch (reason) {
    case 'runs':
      return 'Resume at the same run ceiling: it pauses again at once; use Raise ceiling… to go on';
    case 'budget':
      return 'Resume at the same spend ceiling: it pauses again once nothing is live; use Raise ceiling… to go on';
    case 'human':
    case 'fill-failed':
    case undefined:
      return 'Resume the fan-out at its ceilings: new runs start in free agent slots';
  }
}

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

/** A verb drawn as the library's icon-only button: named by its verb (the name it has
    with words), with a Tooltip that says what it does on hover and keyboard focus. A
    disabled one (a verb in flight) keeps its hint: the Tooltip wraps it in a focusable
    span, since a disabled button takes no focus. */
function IconVerb({
  slot,
  name,
  hint,
  icon,
  disabled,
  onClick,
}: {
  slot: string;
  name: string;
  hint: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={hint}>
      <Button
        variant="secondary"
        size="sm"
        data-slot={slot}
        aria-label={name}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
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
   * same waves, and the Flight Plan header since its strip has a Waves cell. */
  waves?: boolean;
  /** An active or paused session's spend pill; the Flight Plan header turns it off since
   * its strip has a Spend cell that says the same amounts (`spendCellWords`). */
  spend?: boolean;
  /** The verbs of an active or paused session as icon-only buttons (still named Pause,
   * Stop, Resume and Raise ceiling…, each with a Tooltip saying what it does), for the
   * Flight Plan header, whose strip is short of room while a fan-out runs or is paused
   * (owner decisions 2026-11-04: Pause and Stop, then Resume and Raise ceiling…). Stop
   * then confirms in a ConfirmDialog first, since only its glyph sets it apart from
   * Pause. Send agents… and Land keep their words, and so does every verb on a touch
   * screen, where no Tooltip opens (`useTouchScreen`). */
  iconVerbs?: boolean;
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
 * cannot drift. Which verbs show is `fanoutVerbs` (lib/fanoutVerbs.ts), the rule the
 * Issues list's group menu also reads; `count.total` stands in for the children while the
 * progress has not resolved. Left to right by session state: `◔ done/total`, the caller's
 * pills, then
 *
 * - no session (or a finished one): Send agents… — or Land once every child is done, and
 *   nothing for a landed milestone or one with no children to send;
 * - active: phase chips, the spend pill against its ceiling, `Waiting on N rulings` when
 *   nothing is live and capped loops remain, the wave strip, Pause, Stop;
 * - paused: the spend pill, why it paused, Resume, Raise ceiling…, Stop;
 *
 * and an Open button last. Header only — no bar under it, no card. Every async verb runs
 * through one busy flag; a failure shows as a red pill in the same row. `iconVerbs` draws
 * Pause and Stop icon-only, with their names and a Tooltip each, and Stop then asks first
 * in a ConfirmDialog; paused, Resume and Raise ceiling… are icon-only as well. On a touch
 * screen every verb keeps its words.
 */
export function FanoutControls({
  milestone,
  model,
  progress,
  count,
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
  spend: showSpend = true,
  iconVerbs = false,
}: FanoutControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The icon-only Stop's confirmation is open.
  const [confirmingStop, setConfirmingStop] = useState(false);
  // A touch screen opens no Tooltip, so an icon-only verb there would be a bare glyph:
  // the verbs keep their words (and Stop its one press), as the strip beside them keeps
  // its notes on the row there.
  const touch = useTouchScreen();
  const iconOnly = iconVerbs && !touch;
  const milestoneId = milestone.meta.id;
  const session = progress?.session ?? null;
  const progressChildren = progress?.children ?? [];
  const verbs = fanoutVerbs(milestone, model, progress, count?.total);
  // Active and paused imply a resolved progress with a session; the narrowing keeps the
  // types honest.
  const active = verbs.includes('pause') && progress !== undefined;
  const paused = verbs.includes('resume') && session !== null;

  // One verb at a time; a rejected handler's message replaces the verbs' error pill.
  // `hold` false leaves the verbs enabled, for a verb whose own dialog waits on it (the
  // icon-only Stop's ConfirmDialog): it keeps the verbs' elements, so the dialog can hand
  // focus back to Stop when it closes.
  async function run(action: () => Promise<void>, hold = true) {
    if (hold) setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (hold) setBusy(false);
    }
  }

  // Settled spend against its ceiling, shown while a session is active or paused. The hover
  // text names the near-ceiling state the amber dot conveys, so it reads without colour.
  let spendPill: ReactNode = null;
  if (showSpend && progress !== undefined) {
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

  // Stop, in an active or a paused session's controls. Icon-only it asks first: its glyph
  // beside Pause's is all that tells the two apart, a touch screen never shows its hint,
  // and a stop cannot be undone.
  const stopVerb = iconOnly ? (
    <IconVerb
      slot="fanout-stop"
      name="Stop"
      hint={STOP_HINT}
      disabled={busy}
      onClick={() => setConfirmingStop(true)}
      icon={<Square {...ICON_ONLY} />}
    />
  ) : (
    <Verb
      disabled={busy}
      onClick={() => void run(() => onStop(milestoneId))}
      icon={<Square {...ICON} />}
    >
      Stop
    </Verb>
  );

  let controls: ReactNode;
  if (active) {
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
        {onPause !== undefined &&
          (iconOnly ? (
            <IconVerb
              slot="fanout-pause"
              name="Pause"
              hint={PAUSE_HINT}
              disabled={busy}
              onClick={() => void run(() => onPause(milestoneId))}
              icon={<Pause {...ICON_ONLY} />}
            />
          ) : (
            <Verb
              disabled={busy}
              onClick={() => void run(() => onPause(milestoneId))}
              icon={<Pause {...ICON} />}
            >
              Pause
            </Verb>
          ))}
        {stopVerb}
      </>
    );
  } else if (paused) {
    // The ceiling that tripped stays on screen next to Raise ceiling…; a caller that
    // turns the pill off (the Flight Plan header) leads its own strip with the spend.
    controls = (
      <>
        {spendPill}
        <Pill slot="paused-pill" tone="warning" title={session.pausedDetail}>
          {session.pausedReason === undefined
            ? 'Paused'
            : pausedReasonLabel(session.pausedReason)}
        </Pill>
        {onResume !== undefined &&
          (iconOnly ? (
            <IconVerb
              slot="fanout-resume"
              name="Resume"
              hint={resumeHint(session.pausedReason)}
              disabled={busy}
              onClick={() => void run(() => onResume(milestoneId))}
              icon={<Play {...ICON_ONLY} />}
            />
          ) : (
            <Verb
              disabled={busy}
              onClick={() => void run(() => onResume(milestoneId))}
              icon={<Play {...ICON} />}
            >
              Resume
            </Verb>
          ))}
        {onRaiseCeiling !== undefined &&
          (iconOnly ? (
            // Its name keeps the ellipsis: it opens a dialog, which hands focus back to
            // this button when it closes.
            <IconVerb
              slot="fanout-raise"
              name="Raise ceiling…"
              hint={RAISE_HINT}
              disabled={busy}
              onClick={() => onRaiseCeiling(milestoneId)}
              icon={<ChevronsUp {...ICON_ONLY} />}
            />
          ) : (
            <Verb
              disabled={busy}
              onClick={() => onRaiseCeiling(milestoneId)}
              icon={<ChevronsUp {...ICON} />}
            >
              Raise ceiling…
            </Verb>
          ))}
        {stopVerb}
      </>
    );
  } else if (verbs.includes('land') && onLand !== undefined) {
    controls = (
      <Verb
        disabled={busy}
        onClick={() => void run(() => onLand(milestoneId))}
        icon={<GitMerge {...ICON} />}
      >
        Land
      </Verb>
    );
  } else if (verbs.length === 0) {
    // Nothing to send: a landed milestone is done, and an empty milestone would open a dialog
    // whose confirm is disabled.
    controls = null;
  } else {
    // Send agents… — also where Land falls back for a caller with no land wiring, as the
    // board did before Land existed.
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
      {iconOnly && (active || paused) && (
        <ConfirmDialog
          open={confirmingStop}
          data-slot="fanout-stop-confirm"
          title="Stop the fan-out?"
          confirmLabel="Stop fan-out"
          tone="danger"
          // The dialog waits on the stop (its confirm busy) and closes once it settles; a
          // failure shows as the verbs' error pill.
          onConfirm={() =>
            run(() => onStop(milestoneId), false).finally(() =>
              setConfirmingStop(false)
            )
          }
          onCancel={() => setConfirmingStop(false)}
        >
          Runs already live go on, but no new ones start, and a stopped fan-out
          cannot be resumed. Pause it instead to start it again later.
        </ConfirmDialog>
      )}
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
