/**
 * The one vocabulary every dense surface in the app groups and colors by — the names match
 * the `--state-*` tokens in the app's styles/tokens.css one-to-one. Only the vocabulary
 * (type, labels, order, urgency/in-flight sets) lives here with the components keyed on it;
 * deriving a `FeedState` from runs and merge-queue entries is app domain logic and stays in
 * the app's `lib/feedState.ts`, which re-exports this module.
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
