import type { RunState } from '@dispatch/client';

import { Pill } from '../ui/Pill';

// Mirrors `statusTone` in lib/taskDisplay.ts's spirit (map a fixed enum to a
// deliberate color) but for RunState rather than a task's tracker-config
// status — a run's six states are fixed by the orchestrator (spec-exact
// strings), never project-configurable, so this can switch on them directly
// instead of falling back to gray for anything unrecognized.
function runStateTone(
  state: RunState
): 'green' | 'blue' | 'red' | 'amber' | 'gray' {
  switch (state) {
    case 'provisioning':
      return 'gray';
    case 'running':
      return 'blue';
    case 'awaiting-approval':
      return 'amber';
    case 'finished':
      return 'green';
    case 'failed':
      return 'red';
    case 'cancelled':
      return 'gray';
  }
}

interface RunStatePillProps {
  state: RunState;
}

/** Small state badge shared by the Tasks board card indicator, the Runs rail, and the run
 * modal's header — one place owns the RunState -> label/tone mapping so all three always agree. */
export function RunStatePill({ state }: RunStatePillProps) {
  return (
    <Pill variant="status" tone={runStateTone(state)}>
      {state}
    </Pill>
  );
}
