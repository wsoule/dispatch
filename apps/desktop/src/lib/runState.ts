import type { RunState } from '@dispatch/client';

// Mirrors packages/server/src/orchestrator/types.ts's TERMINAL_RUN_STATES —
// the desktop UI's own copy of the same "is this run done" check, used to
// decide whether a task/run should render RunLogView (still live) or
// RunReviewView (done, ready for merge/discard/request-changes).
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
  'cancelled',
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}
