import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';

import { deriveRunDisposition } from './runState';

/**
 * The one vocabulary every dense surface in the app groups and colors by.
 *
 * This is deliberately *not* `RunState`, and deliberately not `RunDisposition`
 * either. `RunState` records how the agent's process ended; `RunDisposition`
 * (lib/runState.ts) answers "whose turn is it" for a run in isolation. Neither
 * can describe the Control room's rows on its own, for two reasons:
 *
 * - A run in the merge queue is no longer about the agent at all — it's about
 *   whether CI will let it land. That's a state the run's own metadata doesn't
 *   have, because it lives in the queue.
 * - Half the rows aren't runs. A ready or blocked task has never had a run, so
 *   any run-derived enum has nothing to say about it.
 *
 * So this is the union of both worlds, and the names match the `--state-*`
 * tokens in styles/tokens.css one-to-one.
 */
export type FeedState =
  | 'working'
  | 'waiting'
  | 'failed'
  | 'review'
  | 'landing'
  | 'ready'
  | 'blocked';

/** Human labels. Second person where the user is the blocker, because the label is the ask. */
export const FEED_STATE_LABEL: Record<FeedState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  failed: 'Failed',
  review: 'Needs review',
  landing: 'Landing',
  ready: 'Ready',
  blocked: 'Blocked',
};

/**
 * The order the Control room's feed groups render in, and the order everything else should
 * sort by when it needs one. Fixed, not data-driven: what needs a human comes first, and it
 * must not reshuffle as counts change or rows would move under the cursor mid-click.
 */
export const FEED_STATE_ORDER: readonly FeedState[] = [
  'waiting',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'blocked',
];

/** States where the user is the thing standing in the way, so the row earns emphasis. */
const URGENT: ReadonlySet<FeedState> = new Set<FeedState>([
  'waiting',
  'failed',
]);

export function isUrgentState(state: FeedState): boolean {
  return URGENT.has(state);
}

/** States with something actively moving, which is what earns the pulsing dot. */
const IN_FLIGHT: ReadonlySet<FeedState> = new Set<FeedState>([
  'working',
  'landing',
]);

export function isInFlightState(state: FeedState): boolean {
  return IN_FLIGHT.has(state);
}

/** Queue states that have come to rest — the entry is out of the pipeline either way. */
const TERMINAL_QUEUE_STATES: ReadonlySet<MergeQueueEntryState> =
  new Set<MergeQueueEntryState>(['merged', 'failed']);

/**
 * What a queued run's row should read as.
 *
 * `blocked-environment` is the interesting one: the queue holds the entry rather than failing
 * it, because the cause is a dirty checkout the user can fix. It is not a failure, but it is
 * also not progress — nothing advances until a human acts, which makes it the same ask as an
 * approval. So it reads as urgent rather than as landing, otherwise a permanently-stalled
 * entry sits in the calm part of the feed looking like it's still working.
 */
function queueEntryToFeedState(entry: MergeQueueEntry): FeedState | null {
  if (entry.state === 'merged') return null;
  if (entry.state === 'failed' || entry.state === 'blocked-environment') {
    return 'failed';
  }
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
  if (meta.state === 'awaiting-approval') return 'waiting';

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
