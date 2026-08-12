import type { RunMeta, RunState } from '@dispatch/client';

import { deriveRunDisposition, runDispositionLabel } from '../../lib/runState';
import type { FeedState } from '@/lib/feedState';
import { cn } from '@/lib/utils';
import { StateDot } from '@/ui/chrome/StateDot';

// Mirrors `statusTone` in lib/taskDisplay.ts's spirit (map a fixed enum to a
// deliberate color) but for RunState rather than a task's tracker-config
// status — a run's six states are fixed by the orchestrator (spec-exact
// strings), never project-configurable, so this can switch on them directly
// instead of falling back to gray for anything unrecognized.
const RUN_STATE_LABEL: Record<RunState, string> = {
  provisioning: 'Provisioning',
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  finished: 'Finished',
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
  'awaiting-approval': 'waiting',
  finished: 'review',
  failed: 'failed',
  cancelled: 'blocked',
  'interrupted-dirty': 'failed',
};

interface RunStatePillProps {
  meta: RunMeta;
  className?: string;
}

/** Small state indicator shared by the Tasks board card, the Runs rail, and the run detail
 * header — one place owns the RunState -> label/color mapping so all three always agree.
 * Per the redesign brief, status renders as a small colored dot + label rather than a
 * bordered/background pill box; the dot pulses gently while the run is actively in flight.
 *
 * Takes the whole `RunMeta` rather than just `state` because `RunState` alone cannot say what
 * a run needs from a human: two runs on `finished` differ on whether anyone reviewed them, and
 * two on `failed` differ on whether a session remains to continue from. The disposition badge
 * beside the state answers that (see `deriveRunDisposition`), and deriving it here rather than
 * at each of this component's five call sites is what keeps every surface agreeing — a run
 * reading "Needs review" in the Runs rail but bare "Finished" on a board card is exactly the
 * inconsistency this exists to remove. */
export function RunStatePill({ meta, className }: RunStatePillProps) {
  const state = meta.state;
  const inFlight = state === 'provisioning' || state === 'running';
  const badge = runDispositionLabel(
    deriveRunDisposition(meta),
    meta.reviewAction
  );
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground',
        className
      )}
    >
      <StateDot state={RUN_STATE_TONE[state]} pulse={inFlight} />
      {RUN_STATE_LABEL[state]}
      {badge !== null && (
        <span className="border-border text-muted-foreground rounded-chip border px-1 py-px text-[10px] leading-none">
          {badge}
        </span>
      )}
    </span>
  );
}
