import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';

import { deriveRunDisposition } from './runState';
import type { TaskRowState } from '@/ui/ai/task-rows';
import type { FeedState } from '@/ui/lib/feedState';

// The FeedState vocabulary (type, labels, order, urgency/in-flight sets) moved to
// @dispatch/ui (packages/ui) with the components keyed on it — the `--state-*` tokens and
// StateMark/StateDot live there. This module keeps the app-domain half: deriving a
// FeedState from runs and merge-queue entries. The re-export keeps `@/lib/feedState` the
// one import path app code needs.
export {
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
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

/**
 * Maps this file's `FeedState` (Control room's dispositions, derived from `runState.ts`) onto
 * `TaskRow`'s own state vocabulary (`ui/ai/task-rows.tsx`) — Task 26's dense-list surfaces
 * (AllAgentsView, SessionsHubView, SessionRow) render rows through `TaskRow`, which only knows
 * five states. Both vocabularies key off the same `--state-*` design tokens, so most of this
 * is a rename rather than a real re-bucketing:
 *
 * - `working` -> `running`, `waiting` -> `waiting`, `failed` -> `failed`: same token, same
 *   meaning, just a different label.
 * - `review` -> `done`: both read as "the agent's part is over, look at it" and share
 *   `bg-state-review`.
 * - `landing` -> `done`: `TaskRow` has no separate "landing" token; a run getting merged has
 *   at least as much finished about it as one awaiting review, so it joins `done` too.
 * - `ready` -> `queued`: both share `bg-state-ready` and mean "hasn't started".
 * - `blocked` -> `queued`: `TaskRow` has no "blocked" token either. A blocked task hasn't
 *   started running any more than a ready one has — it just can't yet, rather than won't
 *   yet — so it lands in the same bucket rather than being force-fit onto `waiting` (which
 *   this file reserves for "waiting on a person", not "waiting on a dependency").
 */
export function feedStateToTaskRowState(state: FeedState): TaskRowState {
  switch (state) {
    case 'working':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'review':
    case 'landing':
      return 'done';
    case 'ready':
    case 'blocked':
      return 'queued';
  }
}
