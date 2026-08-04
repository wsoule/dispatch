/**
 * What a review is looking at: a local run's diff, or a GitHub pull request.
 * Mirrors apps/desktop/src/lib/reviewTarget.ts, which the UI keys on.
 */
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };

/**
 * The on-disk slug for a target's comment file. A run keeps its bare run id,
 * so every review file written before PR targets existed still resolves.
 */
export function reviewTargetSlug(target: ReviewTarget): string {
  return target.kind === 'run' ? target.runId : `pr-${target.number}`;
}
