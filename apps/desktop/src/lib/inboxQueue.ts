import type { RepoPr, RunMeta, RunQuestion } from '@dispatch/client';

import {
  buildReviewQueue,
  type ReviewQueueItem,
} from '../components/runs/ReviewQueue';
import { deriveFeedState } from './feedState';

export interface InboxData {
  /** Finished runs needing a look, plus open repo PRs — exactly what the
   * Review page's queue shows today. */
  review: ReviewQueueItem[];
  /** Live runs stalled on the user: an approval gate or an open question. */
  waiting: RunMeta[];
}

/**
 * Whether a run belongs in `waiting`: a live execute-kind run, not archived,
 * that is either sitting on an approval gate (`deriveFeedState`, which reads
 * that off the run's own `state`) or blocked on a question the agent asked
 * and nobody has answered yet. A question-blocked run's own `RunState` stays
 * 'running' — the process is still up, just parked on stdin — so
 * `deriveFeedState` alone can't see it; only the separate `openQuestions` map
 * (keyed by run id, same as `taskAttention.ts`/`controlRoom.ts` read it) does.
 * Mirrors `buildReviewQueue`'s kind/archived exclusions so a review or verify
 * agent's own RunMeta, or an archived run, never leaks into the Inbox.
 */
function isWaiting(
  run: RunMeta,
  openQuestions: ReadonlyMap<string, RunQuestion[]>
): boolean {
  if ((run.kind ?? 'execute') !== 'execute') return false;
  if (run.archivedAt !== undefined) return false;
  if (deriveFeedState(run) === 'waiting') return true;
  return (openQuestions.get(run.id) ?? []).length > 0;
}

/**
 * Everything waiting on a human, in one list. A thin composition over the two
 * surfaces that already know how to find their half of it — no re-derivation,
 * so a change to either source's rules (what counts as needing review, what
 * counts as waiting) only has to happen in one place.
 */
export function buildInbox(
  runs: RunMeta[],
  repoPrs: RepoPr[],
  openQuestions: ReadonlyMap<string, RunQuestion[]>
): InboxData {
  return {
    review: buildReviewQueue(runs, repoPrs),
    waiting: runs.filter((r) => isWaiting(r, openQuestions)),
  };
}
