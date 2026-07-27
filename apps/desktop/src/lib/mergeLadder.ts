import type { RunMeta } from '@dispatch/client';

/**
 * Where a run's work sits on the merge ladder, derived from `RunMeta` rather
 * than stored: `unmerged` (nothing merged yet), `merged-local` (squash-merged
 * into the base branch locally, but that commit hasn't reached origin), and
 * `on-origin` (the merge commit is reachable from origin's base branch — see
 * `pushedToOrigin` in packages/server/src/orchestrator/types.ts).
 */
export type MergeLadderState = 'unmerged' | 'merged-local' | 'on-origin';

// A run climbs to 'on-origin' either through a local squash-merge that's
// since reached origin (reviewAction 'merge' + mergeCommit + pushedToOrigin),
// or directly through 'pr': markRunMergedViaPr only ever fires once GitHub
// reports the PR itself merged (see orchestrator.ts), so that content is
// already on origin's base branch even though no local mergeCommit exists —
// mergeQueue.ts treats 'merge' and 'pr' as equivalent landed states for the
// same reason. A 'discard' review action, or a 'merge' that failed before
// committing, both stay 'unmerged'.
export function mergeLadderState(meta: RunMeta | undefined): MergeLadderState {
  if (meta === undefined) return 'unmerged';
  if (meta.reviewAction === 'pr') return 'on-origin';
  if (meta.reviewAction !== 'merge' || meta.mergeCommit === undefined) {
    return 'unmerged';
  }
  return meta.pushedToOrigin === true ? 'on-origin' : 'merged-local';
}

// Pulls a PR number out of a GitHub PR URL's trailing `/123` segment, for a
// terser on-origin label than the bare URL — returns undefined rather than
// guessing when the shape doesn't match (a differently-hosted URL, etc.).
function prNumberFrom(prUrl: string | undefined): string | undefined {
  return prUrl?.match(/\/(\d+)\/?$/)?.[1];
}

/** Human-readable text for a ladder state, used as the dot's `title` and in the task header. */
export function mergeLadderLabel(
  state: MergeLadderState,
  branch?: string,
  sha?: string,
  prUrl?: string
): string {
  switch (state) {
    case 'unmerged':
      return 'not merged';
    case 'merged-local':
      return `on ${branch}, not pushed`;
    case 'on-origin': {
      // A PR-merged run never gets a local mergeCommit (see mergeLadderState
      // above), so falling back to the PR wording here — rather than ever
      // interpolating a missing sha — covers that path without needing the
      // caller to know which of the two on-origin routes a run took.
      if (sha === undefined) {
        const prNumber = prNumberFrom(prUrl);
        return prNumber !== undefined
          ? `merged via PR #${prNumber}`
          : 'merged via PR';
      }
      return `in origin (${sha.slice(0, 7)})`;
    }
  }
}
