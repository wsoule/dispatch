import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';

import { deriveRunDisposition } from './runState';
import type { FeedState } from '@/ui/lib/feedState';

// The vocabulary (states, tiers, labels, order, TaskRow mapping) lives in
// @dispatch/ui (packages/ui) with the components keyed on it. This module
// keeps the app-domain half: deriving a state from runs and merge-queue
// entries. The re-export keeps `@/lib/feedState` the one import path app code
// needs.
export {
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  feedStateToTaskRowState,
  feedTier,
  isInFlightState,
  isUrgentState,
  type FeedState,
} from '@/ui/lib/feedState';

/** Queue states that have come to rest — the entry is out of the pipeline either way. */
const TERMINAL_QUEUE_STATES: ReadonlySet<MergeQueueEntryState> =
  new Set<MergeQueueEntryState>(['merged', 'failed']);

/**
 * What a queued run's row should read as.
 *
 * `blocked-environment` is the interesting one: the queue holds the entry rather than failing
 * it, because the cause is a dirty checkout the user can fix. That is its own ask now —
 * `unblock` — rather than being lumped with failures: nothing is broken, but nothing advances
 * until a human acts either.
 */
function queueEntryToFeedState(entry: MergeQueueEntry): FeedState | null {
  if (entry.state === 'merged') return null;
  if (entry.state === 'failed') return 'failed';
  if (entry.state === 'blocked-environment') return 'unblock';
  return 'landing';
}

/**
 * What one run's row should read as, or `null` when it has no place in the feed at all.
 *
 * `null` means closed out — a human already merged or discarded it, so it belongs in history,
 * not in a queue of things to do. Returning null rather than a `'closed'` member keeps callers
 * from having to remember to filter it out of every group.
 *
 * Pass the run's merge-queue entry when it has one; the queue outranks the run's own
 * disposition, since a run that finished and got approved is no longer waiting on a review.
 *
 * This sees only the run and queue. The richer asks — `answer` (open questions), `fixing` /
 * `checking` / `ruling` (the fix loop and aux agents) — need context this function does not
 * take; `buildFeed` (lib/controlRoom.ts) layers those on where that context lives.
 */
export function deriveFeedState(
  meta: RunMeta,
  queueEntry?: MergeQueueEntry
): FeedState | null {
  if (
    queueEntry !== undefined &&
    !TERMINAL_QUEUE_STATES.has(queueEntry.state)
  ) {
    return queueEntryToFeedState(queueEntry);
  }
  if (queueEntry?.state === 'failed') return 'failed';

  // An approval gate is the most urgent thing a run can be doing, and it's the one case where
  // the run is technically still 'live' but has stopped dead. Checked before the disposition
  // for exactly that reason.
  if (meta.state === 'awaiting-approval') return 'approve';

  const disposition = deriveRunDisposition(meta);
  switch (disposition) {
    case 'live':
      return 'working';
    case 'needs-review':
    case 'in-review-elsewhere':
      return 'review';
    // Both mean the agent stopped without finishing and a human has to decide what happens
    // next. They differ in *what* helps — continuing a surviving session versus re-dispatching
    // from scratch — which is a per-row action, not a different group.
    case 'stopped-short':
    case 'dead':
      return 'failed';
    case 'closed':
      return null;
  }
}

/** Task-side counterpart: a task with no live run is either startable or waiting on a dep. */
export function deriveTaskFeedState(ready: boolean): FeedState {
  return ready ? 'ready' : 'blocked';
}
