import type { RunMeta, RunState } from '@dispatch/client';

import { deriveRunDisposition, runDispositionLabel } from '../../lib/runState';
import { cn } from '@/lib/utils';

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
};

const RUN_STATE_DOT: Record<RunState, string> = {
  provisioning: 'bg-muted-foreground/50',
  running: 'bg-blue-500',
  'awaiting-approval': 'bg-amber-500',
  finished: 'bg-emerald-500',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/50',
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
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          RUN_STATE_DOT[state],
          inFlight && 'animate-pulse'
        )}
      />
      {RUN_STATE_LABEL[state]}
      {badge !== null && (
        <span className="border-border text-muted-foreground rounded border px-1 py-px text-[10px] leading-none">
          {badge}
        </span>
      )}
    </span>
  );
}
