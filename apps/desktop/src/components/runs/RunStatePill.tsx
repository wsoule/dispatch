import type { RunMeta, RunState } from '@dispatch/client';

import { deriveRunDisposition, runDispositionLabel } from '../../lib/runState';
import type { FeedState } from '@/lib/feedState';
import { cn } from '@/lib/utils';
import { Pill } from '@/ui/ai/pill';
import { StateMark } from '@/ui/chrome/state-mark';

// A run's states are fixed by the orchestrator (spec-exact strings), never
// project-configurable, so unlike `StatusIcon`'s tracker statuses this can map
// them exhaustively with no fallback. The whose-move vocabulary's words, not
// process states: a run parked on an approval says "Approve" (the ask), a
// finished one says "Review".
const RUN_STATE_LABEL: Record<RunState, string> = {
  provisioning: 'Provisioning',
  running: 'Working',
  'awaiting-approval': 'Approve',
  finished: 'Review',
  failed: 'Failed',
  cancelled: 'Cancelled',
  'interrupted-dirty': 'Interrupted',
};

/**
 * Which state color each `RunState` paints with, as a `FeedState` so this pill and the dense
 * surfaces that group by state can never disagree about what "waiting on you" looks like. The
 * colors themselves are the `--state-*` tokens in styles/tokens.css.
 *
 * One row differs from `deriveFeedState` on purpose: `cancelled` is neutral here, not a
 * failure. The two answer different questions. The Control room asks "does a human owe this
 * something", and a cancelled run does — so it groups with failures there. This pill only
 * reports where the process ended, and a run the user deliberately stopped is not an error;
 * painting it red would claim something broke.
 */
const RUN_STATE_TONE: Record<RunState, FeedState> = {
  provisioning: 'working',
  running: 'working',
  'awaiting-approval': 'approve',
  finished: 'review',
  failed: 'failed',
  cancelled: 'blocked',
  'interrupted-dirty': 'failed',
};

interface RunStatePillProps {
  meta: RunMeta;
  /** The 14px mark alone, for a list row or card where the label would crowd the title;
   * the state and disposition become its accessible name. */
  compact?: boolean;
  className?: string;
}

/** The run-state chip shared by the Tasks board card, the Runs rail, and the run detail
 * header — one place owns the RunState -> label/color mapping so every surface agrees. A
 * 24px `Pill` led by the 14px `StateMark`, on Linear's chip grammar: no dot, no pulse.
 *
 * Takes the whole `RunMeta` rather than just `state` because `RunState` alone cannot say what
 * a run needs from a human: two runs on `finished` differ on whether anyone reviewed them, and
 * two on `failed` differ on whether a session remains to continue from. The disposition pill
 * beside the state answers that (see `deriveRunDisposition`), and deriving it here rather than
 * at each call site is what keeps every surface agreeing — a run reading "Needs review" in
 * the Runs rail but bare "Finished" on a board card is exactly the inconsistency this exists
 * to remove. */
export function RunStatePill({
  meta,
  compact = false,
  className,
}: RunStatePillProps) {
  const state = meta.state;
  const label = RUN_STATE_LABEL[state];
  const badge = runDispositionLabel(
    deriveRunDisposition(meta),
    meta.reviewAction
  );
  const tone = RUN_STATE_TONE[state];

  if (compact) {
    const name = badge === null ? label : `${label} · ${badge}`;
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        data-slot="run-state-mark"
        data-run-state={state}
        className={cn('inline-flex shrink-0 items-center', className)}
      >
        <StateMark state={tone} variant="dot" pulse />
      </span>
    );
  }

  return (
    <span
      data-slot="run-state-pill"
      data-run-state={state}
      className={cn('inline-flex items-center gap-1', className)}
    >
      <Pill>
        <StateMark state={tone} pulse />
        {label}
      </Pill>
      {badge !== null && <Pill className="text-muted-foreground">{badge}</Pill>}
    </span>
  );
}
