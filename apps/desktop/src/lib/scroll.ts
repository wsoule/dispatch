/** How far (in px) from the bottom of a scroll container still counts as "the user is
 * reading the latest content". A few pixels of slack matters because sub-pixel layout
 * rounding and momentum scrolling routinely leave a scroller a fraction short of its true
 * bottom, which would otherwise read as "the user scrolled away" and kill auto-scrolling. */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

/** The three scroll metrics `isPinnedToBottom` needs — a structural subset of `Element` so
 * the check stays a pure function that tests can call with plain objects. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether a scroll container is close enough to its bottom that new content should keep
 * scrolling into view. This is the "stick, don't yank" decision behind the run transcript's
 * auto-scroll: parked at the bottom means follow the agent, scrolled up means the user is
 * reading history and must be left alone.
 */
export function isPinnedToBottom(
  metrics: ScrollMetrics,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX
): boolean {
  const distanceFromBottom =
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom <= threshold;
}
