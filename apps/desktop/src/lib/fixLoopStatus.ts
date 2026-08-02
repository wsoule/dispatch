import type { EscalationStep } from '@dispatch/core/browser';

import type { FixLoopState } from './apiTypes';

/** One line summarizing where a task's fix loop stands — the task row and
 *  detail dialog both render this rather than each spelling out the states. */
export function fixLoopStatusLabel(state: FixLoopState): string {
  switch (state.state) {
    case 'idle':
      return 'Not started';
    case 'implementing':
      return `Round ${state.round}/${state.cap} · Implementing`;
    case 'reviewing':
      return `Round ${state.round}/${state.cap} · Reviewing`;
    case 'capped':
      return `Capped at ${state.round}/${state.cap} — needs a ruling`;
    case 'complete':
      return 'Complete';
  }
}

/** A capped loop is stopped for a human, not for the system — this is the
 *  one bit that decides whether the adjudication control renders at all. */
export function fixLoopNeedsRuling(state: FixLoopState | null): boolean {
  return state?.state === 'capped';
}

// The latest configured rung at or below `round`, falling back to the
// conservative default so an empty or short table never mis-signals.
function rungFor(
  round: number,
  escalation: readonly EscalationStep[]
): EscalationStep {
  let chosen: EscalationStep | null = null;
  for (const step of escalation) {
    if (step.round > round) continue;
    if (chosen === null || step.round >= chosen.round) chosen = step;
  }
  return chosen ?? { round, strategy: 'resume', modelTier: 'standard' };
}

/** Whether the loop's *next* round would hand off to a fresh implementer
 *  rather than resuming the current one. */
export function willEscalateNextRound(
  state: FixLoopState,
  escalation: readonly EscalationStep[]
): boolean {
  return rungFor(state.round + 1, escalation).strategy === 'fresh';
}
