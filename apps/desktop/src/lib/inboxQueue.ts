import type { RepoPr, RunMeta } from '@dispatch/client';

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
 * Everything waiting on a human, in one list. A thin composition over the two
 * surfaces that already know how to find their half of it — no re-derivation,
 * so a change to either source's rules (what counts as needing review, what
 * counts as waiting) only has to happen in one place.
 */
export function buildInbox(runs: RunMeta[], repoPrs: RepoPr[]): InboxData {
  return {
    review: buildReviewQueue(runs, repoPrs),
    waiting: runs.filter((r) => deriveFeedState(r) === 'waiting'),
  };
}
