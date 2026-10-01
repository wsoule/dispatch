export const RETRY_FIRST_MS = 30_000;
export const RETRY_MAX_MS = 3_600_000;
export const GIVE_UP_MS = 86_400_000;
export const TRACK_LIMIT_MS = 7 * 86_400_000;

export type RetryDecision =
  | { kind: 'retry'; at: string }
  | { kind: 'give-up'; reason: string };

// When to try a failed relay again, or why to stop (spec:1467-1472). 408 and
// 429 are retried like 5xx, honouring Retry-After (Decision D14).
export function retrySchedule(
  attempts: number,
  firstAttemptAt: string,
  now: Date,
  failure: { status: number | null; retryAfterSec?: number | null }
): RetryDecision {
  const { status } = failure;
  const transient =
    status === null || status >= 500 || status === 408 || status === 429;
  if (!transient)
    return { kind: 'give-up', reason: `the peer answered HTTP ${status}` };
  if (now.getTime() - Date.parse(firstAttemptAt) >= GIVE_UP_MS)
    return { kind: 'give-up', reason: 'unreachable for 24 h' };
  const backoff = Math.min(
    RETRY_FIRST_MS * 2 ** Math.min(Math.max(0, attempts - 1), 20),
    RETRY_MAX_MS
  );
  const hinted = failure.retryAfterSec;
  const delay =
    hinted === null || hinted === undefined
      ? backoff
      : Math.min(Math.max(hinted * 1000, 1000), RETRY_MAX_MS);
  return { kind: 'retry', at: new Date(now.getTime() + delay).toISOString() };
}

/** How long to wait before the next poll of a peer task: 5 s doubling to 60 s. */
export function pollDelayMs(polls: number): number {
  return Math.min(5000 * 2 ** Math.min(Math.max(0, polls), 4), 60_000);
}
