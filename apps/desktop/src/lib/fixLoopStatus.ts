import type { FixLoopState } from '@dispatch/client';
import type { EscalationStep } from '@dispatch/core/browser';

// `@dispatch/client` exports the state but not its stop-reason union, so name
// it off the state rather than restating the members here.
export type FixLoopStop = NonNullable<FixLoopState['stopReason']>;

/** How a capped loop should read: `waiting` asks the user for something,
 *  `failed` reports a breakage, `neutral` is stopped with nothing to do. */
export type FixLoopTone = 'waiting' | 'failed' | 'neutral';

/** Why a stopped loop stopped. A loop capped before this field existed has no
 *  `stopReason`, so fall back to the server's own `rounds-exhausted`. */
function fixLoopStopReason(state: FixLoopState): FixLoopStop {
  return state.stopReason ?? 'rounds-exhausted';
}

/** One line summarizing where a task's fix loop stands — rendered on the
 *  task detail dialog only; there's no bulk route to fetch this for a row. */
export function fixLoopStatusLabel(state: FixLoopState): string {
  switch (state.state) {
    case 'idle':
      return 'Not started';
    case 'implementing':
      return `Round ${state.round}/${state.cap} · Implementing`;
    case 'reviewing':
      return `Round ${state.round}/${state.cap} · Reviewing`;
    case 'capped':
      return cappedLabel(state);
    case 'complete':
      return 'Complete';
  }
}

function cappedLabel(state: FixLoopState): string {
  const at = `${state.round}/${state.cap}`;
  switch (fixLoopStopReason(state)) {
    case 'standing-block':
      return `Stopped at ${at}: held by a blocking ruling`;
    case 'error':
      return `Stopped at ${at}: the loop failed`;
    case 'stopped':
      return `Stopped at ${at} by you`;
    case 'rounds-exhausted':
      return `Capped at ${at}: needs a ruling`;
  }
}

/** Whether the adjudication control renders. Only `rounds-exhausted` leaves
 *  anything to rule on; the others would be a CTA with nothing behind it. */
export function fixLoopNeedsRuling(state: FixLoopState | null): boolean {
  return (
    state !== null &&
    state.state === 'capped' &&
    fixLoopStopReason(state) === 'rounds-exhausted'
  );
}

/** The visual weight the fix-loop card carries: only a loop actually waiting
 *  on the user earns the amber "needs you" treatment. */
export function fixLoopTone(state: FixLoopState): FixLoopTone {
  if (state.state !== 'capped') return 'neutral';
  const reason = fixLoopStopReason(state);
  if (reason === 'error') return 'failed';
  // A user-stop is a decision already made, not a request for one.
  return reason === 'rounds-exhausted' ? 'waiting' : 'neutral';
}

/** The failure text behind an errored loop, or null when there is nothing
 *  extra to show — `stopDetail` is only meaningful alongside `error`. */
export function fixLoopStopDetail(state: FixLoopState): string | null {
  if (state.state !== 'capped') return null;
  if (fixLoopStopReason(state) !== 'error') return null;
  const detail = state.stopDetail?.trim() ?? '';
  return detail === '' ? null : detail;
}

export interface FixLoopCappedNotice {
  title: string;
  body: string;
}

/** Toast and inbox wording for a `fixloop.capped` event. The row is durable,
 *  so it must not outlive what it asks for — hence branching on the reason. */
export function fixLoopCappedNotice(
  taskTitle: string,
  reason: FixLoopStop,
  message?: string
): FixLoopCappedNotice {
  switch (reason) {
    case 'standing-block':
      return {
        title: 'Fix loop stopped',
        body: `${taskTitle} is held by a blocking ruling.`,
      };
    case 'error':
      return {
        title: 'Fix loop failed',
        body:
          message === undefined || message.trim() === ''
            ? `${taskTitle}'s fix loop stopped on an error.`
            : `${taskTitle}: ${message.trim()}`,
      };
    case 'stopped':
      return {
        title: 'Fix loop stopped',
        body: `${taskTitle}'s fix loop was stopped.`,
      };
    case 'rounds-exhausted':
      return {
        title: 'Fix loop capped',
        body: `${taskTitle} needs a ruling on its open findings.`,
      };
  }
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

/** Whether the loop's *next* round hands off to a fresh implementer — false
 *  once stopped (`capped`/`complete`) or `round >= cap`. */
export function willEscalateNextRound(
  state: FixLoopState,
  escalation: readonly EscalationStep[]
): boolean {
  if (state.state === 'capped' || state.state === 'complete') return false;
  if (state.round >= state.cap) return false;
  return rungFor(state.round + 1, escalation).strategy === 'fresh';
}
