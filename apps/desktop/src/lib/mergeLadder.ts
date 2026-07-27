import type { RunMeta } from '@dispatch/client';

/**
 * Where a run's work sits on the merge ladder, derived from `RunMeta` rather
 * than stored: `unmerged` (nothing merged yet), `merged-local` (squash-merged
 * into the base branch locally, but that commit hasn't reached origin), and
 * `on-origin` (the merge commit is reachable from origin's base branch — see
 * `pushedToOrigin` in packages/server/src/orchestrator/types.ts).
 */
export type MergeLadderState = 'unmerged' | 'merged-local' | 'on-origin';

// A run only climbs the ladder once its review action was 'merge' and it
// actually produced a merge commit — a 'discard'/'pr' review action, or a
// 'merge' that failed before committing, both stay 'unmerged'.
export function mergeLadderState(meta: RunMeta | undefined): MergeLadderState {
  if (meta === undefined) return 'unmerged';
  if (meta.reviewAction !== 'merge' || meta.mergeCommit === undefined) {
    return 'unmerged';
  }
  return meta.pushedToOrigin === true ? 'on-origin' : 'merged-local';
}

/** Human-readable text for a ladder state, used as the dot's `title` and in the task header. */
export function mergeLadderLabel(
  state: MergeLadderState,
  branch?: string,
  sha?: string
): string {
  switch (state) {
    case 'unmerged':
      return 'not merged';
    case 'merged-local':
      return `on ${branch}, not pushed`;
    case 'on-origin':
      return `in origin (${sha?.slice(0, 7)})`;
  }
}
