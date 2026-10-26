/**
 * The feed-state vocabulary as the two remaining legacy components need it: `StateMark`
 * colours its mark by the tier, and `TaskRow` maps its own states onto these names.
 *
 * The organizing rule: a state names whose move it is AND what the move is.
 * Color comes from the tier (amber = your move, red = broken, blue = the
 * machine's move, gray = resting); the glyph names the specific move — see
 * `StateMark`. The app's `lib/feedState.ts` owns the full vocabulary (labels, order,
 * urgency) and the app-domain derivation; this copy keeps only the states and their tier,
 * and goes with `StateMark` and `TaskRow`.
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
