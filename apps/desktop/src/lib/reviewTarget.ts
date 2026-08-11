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

/**
 * The PR number out of a run's `prUrl`, or `null` when there is no PR or the
 * URL does not end in one. A run records where its PR lives, not its number,
 * and the PR review page is keyed by number.
 */
export function prNumberFromUrl(prUrl: string | undefined): number | null {
  const match = prUrl?.match(/\/(\d+)\/?$/)?.[1];
  return match === undefined ? null : Number(match);
}
