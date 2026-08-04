/**
 * What a review is looking at: a local run's diff, or a GitHub PR. The shared
 * key across the queue, the diff fetch, and the comment store.
 */
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };

/** A stable string key for React lists and query keys. */
export function reviewTargetKey(target: ReviewTarget): string {
  return target.kind === 'run' ? `run:${target.runId}` : `pr:${target.number}`;
}
