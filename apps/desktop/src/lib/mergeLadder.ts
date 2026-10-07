import type { RunMeta } from '@dispatch/client';

/**
 * Where a run's work sits on the merge ladder, derived from `RunMeta` rather
 * than stored:
 * - `unmerged`: nothing merged yet.
 * - `merged-local`: squash-merged into the local base, but the project has a
 *   remote and the commit never reached it. This is the split-brain a landing
 *   must never be mistaken for: it reads "Merged locally — not on GitHub yet"
 *   and offers a retry, never plain "landed".
 * - `local-only`: merged into a base that has no remote to reach (a project
 *   without one, or an epic integration branch). Landed, honestly, locally.
 * - `on-origin`: the merge commit is reachable from origin's base branch (see
 *   `pushedToOrigin` / `landsOn` in packages/server/src/orchestrator/types.ts).
 */
export type MergeLadderState =
  | 'unmerged'
  | 'merged-local'
  | 'local-only'
  | 'on-origin';

// A run climbs to 'on-origin' either through a merge whose commit is on origin
// (reviewAction 'merge' + mergeCommit + pushedToOrigin), or directly through
// 'pr': markRunMergedViaPr only ever fires once GitHub reports the PR itself
// merged, so that content is already on origin's base even though no local
// mergeCommit exists. A 'discard', or a 'merge' that failed before
// committing, both stay 'unmerged'. A daemon too old to send `landsOn` reads
// an unpushed merge as 'merged-local', the cautious answer.
export function mergeLadderState(meta: RunMeta | undefined): MergeLadderState {
  if (meta === undefined) return 'unmerged';
  if (meta.reviewAction === 'pr') return 'on-origin';
  if (meta.reviewAction !== 'merge' || meta.mergeCommit === undefined) {
    return 'unmerged';
  }
  if (meta.pushedToOrigin === true) return 'on-origin';
  return meta.landsOn === 'local' ? 'local-only' : 'merged-local';
}

// Pulls a PR number out of a GitHub PR URL's trailing `/123` segment, for a
// terser on-origin label than the bare URL — returns undefined rather than
// guessing when the shape doesn't match (a differently-hosted URL, etc.).
function prNumberFrom(prUrl: string | undefined): string | undefined {
  return prUrl?.match(/\/(\d+)\/?$/)?.[1];
}

// The run-state role each rung paints with: resting grey until something
// merges, amber while a push to origin is still owed, the landing teal once
// the work is where it is going (origin, or local when there is no remote).
const MERGE_LADDER_TINT: Record<MergeLadderState, string> = {
  unmerged: 'var(--state-ready-fg)',
  'merged-local': 'var(--state-waiting-fg)',
  'local-only': 'var(--state-landing-fg)',
  'on-origin': 'var(--state-landing-fg)',
};

/** The `--state-*` colour for a ladder state, as a CSS value a `LabelPill` dot can take. */
export function mergeLadderTint(state: MergeLadderState): string {
  return MERGE_LADDER_TINT[state];
}

const MERGE_LADDER_PILL_LABEL: Record<MergeLadderState, string> = {
  unmerged: 'Not merged',
  'merged-local': 'Not on GitHub',
  'local-only': 'Landed locally',
  'on-origin': 'On origin',
};

/** The short pill wording for a rung; `mergeLadderLabel` below is the full sentence. */
export function mergeLadderPillLabel(state: MergeLadderState): string {
  return MERGE_LADDER_PILL_LABEL[state];
}

const EPIC_BRANCH = /^epic\//;

/**
 * Where a run's work went, in the words every surface uses: "Landed on
 * origin/main · abc1234", "Merged locally — not on GitHub yet", "Landed
 * locally (no remote)". Never a bare "landed": the destination is the point.
 */
export function mergeLadderLabel(meta: RunMeta | undefined): string {
  const state = mergeLadderState(meta);
  switch (state) {
    case 'unmerged':
      return 'not merged';
    case 'merged-local':
      return 'Merged locally — not on GitHub yet';
    case 'local-only':
      return meta !== undefined && EPIC_BRANCH.test(meta.baseBranch)
        ? `Landed on ${meta.baseBranch} (local epic branch)`
        : 'Landed locally (no remote)';
    case 'on-origin': {
      // A PR-merged run never gets a local mergeCommit (see mergeLadderState
      // above), so it says which PR rather than interpolating a missing sha.
      const sha = meta?.mergeCommit;
      if (sha === undefined) {
        const prNumber = prNumberFrom(meta?.prUrl);
        return prNumber !== undefined
          ? `Landed via PR #${prNumber}`
          : 'Landed via PR';
      }
      return `Landed on origin/${meta?.baseBranch ?? 'main'} · ${sha.slice(0, 7)}`;
    }
  }
}

/**
 * What the Land button says before anything happens: where a click puts the
 * work. A run the daemon did not tag (an older daemon) gets the plain verb
 * rather than a guess.
 */
export function landButtonLabel(meta: RunMeta): string {
  if (meta.landsOn === 'origin') return `Land on origin/${meta.baseBranch}`;
  if (meta.landsOn === 'local') return `Land on local ${meta.baseBranch}`;
  return 'Land';
}

/** "in v0.39.1" or "not released yet" for a landed run, when the repo tags releases. */
export function releaseLabel(meta: RunMeta | undefined): string | undefined {
  if (meta?.release === undefined) return undefined;
  return meta.release.included ? `in ${meta.release.tag}` : 'not released yet';
}

/** The GitHub page for a landed run's commit, when origin is on GitHub. */
export function landedCommitUrl(
  meta: RunMeta | undefined,
  originWebUrl: string | undefined
): string | undefined {
  if (originWebUrl === undefined || meta?.mergeCommit === undefined) {
    return undefined;
  }
  if (mergeLadderState(meta) !== 'on-origin') return undefined;
  return `${originWebUrl}/commit/${meta.mergeCommit}`;
}
