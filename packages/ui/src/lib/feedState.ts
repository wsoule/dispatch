import type { TaskRowState } from '../ai/task-rows';

/**
 * The one vocabulary every dense surface in the app groups and colors by.
 *
 * The organizing rule: a state names whose move it is AND what the move is.
 * Color comes from the tier (amber = your move, red = broken, blue = the
 * machine's move, gray = resting); the glyph names the specific move — see
 * `StateMark`. Only the vocabulary lives here with the components keyed on it;
 * deriving a state from runs, queues, questions, and fix loops is app domain
 * logic (the app's `lib/feedState.ts`, which re-exports this module).
 */
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
export type FeedTier = 'you' | 'broken' | 'machine' | 'resting';

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

export function feedTier(state: FeedState): FeedTier {
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
