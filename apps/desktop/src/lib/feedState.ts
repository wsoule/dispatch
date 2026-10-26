import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';

import { deriveRunDisposition } from './runState';

/**
 * The one vocabulary every dense surface in the app groups and colors by, and the
 * app-domain derivation that turns runs and merge-queue entries into it. Both halves
 * live here now, and `@/lib/feedState` is the one import path app code uses. The
 * legacy copy in @dispatch/ui-legacy (`ui-legacy/src/lib/feedState.ts`) stays only
 * for its `StateMark` and `TaskRow` until those components go.
 *
 * The organizing rule: a state names whose move it is AND what the move is.
 * Color comes from the tier (amber = your move, red = broken, blue = the
 * machine's move, gray = resting); the glyph names the specific move — see
 * `StateMark`.
 */

/**
 * `TaskRow`'s own five states. Mirrors the union in ui-legacy's `ai/task-rows.tsx`, which
 * AllAgentsView still feeds into the legacy `TaskRow`; B4 removes this together with
 * `feedStateToTaskRowState`.
 */
type TaskRowState = 'running' | 'waiting' | 'failed' | 'done' | 'queued';

export type FeedState =
  // Your move — each one is a different ask with a different cost.
  | 'answer' // an agent asked a free-text question
  | 'approve' // an agent wants a tool approval — one click
  | 'review' // a finished run's diff wants human eyes
  | 'ruling' // a capped fix loop needs findings adjudicated
  | 'unblock' // the merge queue is held on a dirty checkout
  // Broken — nothing proceeds until a human retries or reads the error.
  | 'failed'
  // The machine's move — watchable, not actionable.
  | 'working'
  | 'fixing' // a fix-loop round is implementing
  | 'checking' // review/verify agents are running
  | 'landing'
  // Resting — tasks that have not started.
  | 'ready'
  | 'blocked';

/** Whose move a state is — the hue carrier. */
type FeedTier = 'you' | 'broken' | 'machine' | 'resting';

const TIER: Record<FeedState, FeedTier> = {
  answer: 'you',
  approve: 'you',
  review: 'you',
  ruling: 'you',
  unblock: 'you',
  failed: 'broken',
  working: 'machine',
  fixing: 'machine',
  checking: 'machine',
  landing: 'machine',
  ready: 'resting',
  blocked: 'resting',
};

function feedTier(state: FeedState): FeedTier {
  return TIER[state];
}

/** Human labels. Verbs where the user is the blocker, because the label is the ask. */
export const FEED_STATE_LABEL: Record<FeedState, string> = {
  answer: 'Answer',
  approve: 'Approve',
  review: 'Review',
  ruling: 'Ruling',
  unblock: 'Unblock',
  failed: 'Failed',
  working: 'Working',
  fixing: 'Fixing',
  checking: 'AI review',
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
  'answer',
  'approve',
  'review',
  'ruling',
  'unblock',
  'failed',
  'working',
  'fixing',
  'checking',
  'landing',
  'ready',
  'blocked',
];

/** States where the user is the thing standing in the way, so the row earns emphasis. */
export function isUrgentState(state: FeedState): boolean {
  const tier = feedTier(state);
  return tier === 'you' || tier === 'broken';
}

/** States with something actively moving, which is what earns the pulsing mark. */
export function isInFlightState(state: FeedState): boolean {
  return feedTier(state) === 'machine';
}

/**
 * Maps the feed vocabulary onto `TaskRow`'s own five states (`ui/ai/task-rows.tsx`) — the
 * dense-list surfaces (AllAgentsView, SessionsHubView, SessionRow) render rows through
 * `TaskRow`. Both vocabularies key off the same design tokens, so this is mostly a
 * re-bucketing by tier: your-move states read as `waiting`, machine states as `running`,
 * except where TaskRow has a closer word (`done` for review/landing, `failed` for failed).
 */
export function feedStateToTaskRowState(state: FeedState): TaskRowState {
  switch (state) {
    case 'answer':
    case 'approve':
    case 'ruling':
    case 'unblock':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'working':
    case 'fixing':
    case 'checking':
      return 'running';
    case 'review':
    case 'landing':
      return 'done';
    case 'ready':
    case 'blocked':
      return 'queued';
  }
}

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
