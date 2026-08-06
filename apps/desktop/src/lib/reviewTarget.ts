import type { ReviewTarget } from '@dispatch/client';

/**
 * What a review is looking at: a local run's diff, or a GitHub PR. The type
 * is the wire type from @dispatch/client — one declaration for one concept —
 * re-exported here so the UI imports it beside `reviewTargetKey`.
 */
export type { ReviewTarget };

/** A stable string key for React lists and query keys. */
export function reviewTargetKey(target: ReviewTarget): string {
  return target.kind === 'run' ? `run:${target.runId}` : `pr:${target.number}`;
}
