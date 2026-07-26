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
