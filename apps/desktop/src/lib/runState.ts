import type { RunMeta, RunState, RunSurvey } from '@dispatch/client';

// Mirrors packages/server/src/orchestrator/types.ts's TERMINAL_RUN_STATES —
// the desktop UI's own copy of the same "is this run done" check, used to
// decide whether a task/run should render RunLogView (still live) or
// RunReviewView (done, ready for merge/discard/request-changes).
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
]);

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

/**
 * What a run currently wants from a human, derived rather than stored.
 *
 * `RunState` alone can't answer this: it records how the agent's *process*
 * ended, while the useful question is "whose turn is it, and to do what". Two
 * runs both sitting on `finished` want completely different things depending
 * on whether a human has already closed them out, and two runs both on
 * `failed` differ on whether there's a session left to continue from.
 *
 * - `live` — still working; nothing owed.
 * - `needs-review` — **the agent finished its work and a human still owes it a
 *   look.** Deliberately a pure signal: it gates nothing. Downstream tasks
 *   auto-start exactly as before and merging is unaffected; this only marks
 *   the run as belonging in a human's review queue.
 * - `stopped-short` — came to rest before finishing (a usage-limit
 *   truncation, a cancel) but still has a session, so the actionable next step
 *   is to continue it, not to review it.
 * - `dead` — stopped with no session to resume from; only re-dispatching
 *   from scratch will help.
 * - `in-review-elsewhere` — an open PR moved review to GitHub, so the local
 *   review queue must not also claim it.
 * - `closed` — a human already merged/discarded it.
 */
export type RunDisposition =
  | 'live'
  | 'needs-review'
  | 'stopped-short'
  | 'dead'
  | 'in-review-elsewhere'
  | 'closed';

/**
 * The short badge text for a disposition, or `null` when a run needs no badge.
 *
 * Kept separate from `deriveRunDisposition` on purpose: that function decides
 * *what kind of situation* a run is in, and this one only chooses wording. It is
 * why `RunDisposition` has a single coarse `closed` rather than merged/discarded
 * variants — encoding review bookkeeping in the type would blur the "whose turn
 * is it, and to do what" question the type exists to answer.
 *
 * `live` and `dead` return `null`: the state pill beside the badge already says
 * "Running" and "Failed"/"Cancelled" respectively, and neither has anything a
 * human can act on, so a badge would be pure noise.
 */
export function runDispositionLabel(
  disposition: RunDisposition,
  reviewAction?: RunMeta['reviewAction']
): string | null {
  switch (disposition) {
    case 'live':
    case 'dead':
      return null;
    case 'needs-review':
      return 'Needs review';
    case 'stopped-short':
      return 'Continue';
    case 'in-review-elsewhere':
      return 'PR open';
    case 'closed':
      // A reviewed run with no recorded action still needs a word, and "Closed"
      // is the honest one — reading it as "Merged" would assert that work landed
      // when nothing recorded that it did.
      if (reviewAction === 'discard') return 'Discarded';
      if (reviewAction === 'merge' || reviewAction === 'pr') return 'Merged';
      return 'Closed';
  }
}

export function deriveRunDisposition(meta: RunMeta): RunDisposition {
  if (!isTerminalRunState(meta.state)) return 'live';
  // `reviewedAt` is the orchestrator's one-way "a human closed this out"
  // marker (see RunMeta) and outranks everything below it — including a failed
  // terminal state, since discarding a failed run is a perfectly normal way to
  // close one out.
  if (meta.reviewedAt !== undefined) return 'closed';
  if (meta.prUrl !== undefined) return 'in-review-elsewhere';
  if (meta.state === 'finished') return 'needs-review';
  // Failed or cancelled. A session id is exactly what the server's resume gate
  // requires (see Orchestrator.sendMessage), so it's also what decides whether
  // this run can offer a "continue" affordance at all — advertising one for a
  // run the server would refuse to resume is worse than showing none.
  const resumable = meta.sessionId !== undefined && meta.sessionId !== '';
  return resumable ? 'stopped-short' : 'dead';
}

/**
 * What Continue resumes a `stopped-short` run with when the composer is empty.
 * Such a run was cut off rather than wrong, so there is nothing to critique —
 * it needs re-orienting, which is why this says where to look rather than just
 * "carry on".
 */
export const CONTINUE_PROMPT =
  'Continue where you left off. Re-read the task and your own transcript above first, then pick up from the last thing you were doing.';

/** The text a Continue click sends: the typed draft when there is one, so hitting
 * Continue instead of Request changes never discards what was written. */
export function continueMessage(draft: string): string {
  const typed = draft.trim();
  return typed === '' ? CONTINUE_PROMPT : typed;
}

export interface RunSurveyNotice {
  title: string;
  body: string;
}

/**
 * Toast and inbox wording for a `run.survey` event, or `null` when there is nothing to
 * say. The only signal that a run left work behind: the survey lands after the run has
 * already notified as failed, and `interrupted-dirty` is not itself a notifying state.
 * Names the branch because the row is durable and the work is only recoverable there.
 */
export function runSurveyNotice(
  taskTitle: string,
  survey: RunSurvey
): RunSurveyNotice | null {
  const paths =
    survey.staged.length + survey.unstaged.length + survey.untracked.length;
  if (paths === 0) return null;
  return {
    title: 'Run left uncommitted work',
    body: `${taskTitle} — ${paths} uncommitted path${paths === 1 ? '' : 's'} on ${survey.branch}`,
  };
}

/** What the halting controls should render for one run — see `deriveStopControl`. */
export interface StopControl {
  /** Whether the Stop and Cancel buttons belong on screen at all. */
  showButtons: boolean;
  /** Stop's label: it doubles as the status line for a stop already in flight. */
  stopLabel: 'Stop' | 'Stopping…';
  /** True once a stop is in flight — Stop has nothing left to ask for. */
  stopDisabled: boolean;
  /** Whether a terminal run should be marked as having been deliberately stopped. */
  showStoppedChip: boolean;
}

/**
 * How a run's halting controls should read, derived from the run itself rather
 * than from whether this session happens to have clicked Stop.
 *
 * `stopRequestedAt` is a server-side marker that outlives the click, so a reload,
 * a daemon restart, or switching runs and back all still show a stop in flight.
 * The three cases it distinguishes: live and never stopped (offer Stop), live and
 * stopping (say so, and keep Cancel available as the escape hatch for an agent
 * taking too long), and terminal after a stop (say it was stopped, because a bare
 * "Finished" would read as a run that completed its task).
 */
export function deriveStopControl(meta: RunMeta): StopControl {
  const live = !isTerminalRunState(meta.state);
  const stopRequested = meta.stopRequestedAt !== undefined;
  return {
    showButtons: live,
    stopLabel: stopRequested ? 'Stopping…' : 'Stop',
    stopDisabled: stopRequested,
    showStoppedChip: !live && stopRequested,
  };
}
