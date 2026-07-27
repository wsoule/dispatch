import type { RunMeta, RunState } from '@dispatch/client';

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
