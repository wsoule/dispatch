import type { BranchEntry, RunMeta } from '@dispatch/client';

import { STALE_AFTER_MS } from './gitHealth';

/**
 * The Landed page's vocabulary: every run branch falls in exactly one bucket,
 * ordered here from "still out" to "safely landed" — the order the page
 * renders its sections in.
 *
 * - 'awaiting-review': a terminal run nobody reviewed — work sitting out.
 * - 'in-progress':     a live run is still writing to this branch.
 * - 'abandoned':       unmerged work nothing owns any more (an orphan ref or
 *                      a failed cleanup's leftover) — nothing will land it.
 * - 'merged-local':    landed on the base branch, but the merge has not
 *                      reached origin — a push away from being shared.
 * - 'merged-pushed':   landed and on origin. Done.
 */
export type LandedBucketId =
  | 'awaiting-review'
  | 'in-progress'
  | 'abandoned'
  | 'merged-local'
  | 'merged-pushed';

export const LANDED_BUCKET_ORDER: LandedBucketId[] = [
  'awaiting-review',
  'in-progress',
  'abandoned',
  'merged-local',
  'merged-pushed',
];

/** One row of the Landed page, whichever side of the join it came from: a
 * still-out branch ref, or a merged run whose ref review() already deleted. */
export interface LandedRow {
  /** Stable render key: the branch name for ref rows, the run id for runs. */
  key: string;
  branch: string;
  baseBranch?: string;
  taskTitle?: string;
  runId?: string;
  /** Ref rows only: commits the base gained past this still-out work. */
  behindBase?: number;
  lastCommitAt?: string;
  /** When the landing review happened, for merged rows that know it. */
  reviewedAt?: string;
  /** Ref rows only: uncommitted changes sitting in the worktree. */
  dirty: boolean;
}

/**
 * Which bucket one branch ref belongs to. Total by construction: merged state
 * is decided first (a merged branch's registry status is a cleanup concern,
 * not a landed/still-out one), then the registry status splits the unmerged
 * rest.
 */
export function landedBucketOf(entry: BranchEntry): LandedBucketId {
  if (entry.mergedIntoBase) {
    return entry.pushedToOrigin ? 'merged-pushed' : 'merged-local';
  }
  if (entry.status === 'active') return 'in-progress';
  if (entry.status === 'reviewable') return 'awaiting-review';
  // 'orphan' | 'leftover': no run owns this unmerged ref, so no review or
  // merge path will ever move it — a human has to decide.
  return 'abandoned';
}

// A run whose work landed on the base branch: reviewed, and the review's
// outcome was a merge — locally ('merge') or on GitHub ('pr'). A discarded
// run landed nothing, and an unreviewed run is still the ref's story.
function isMergedRun(run: RunMeta): boolean {
  return (
    run.reviewedAt !== undefined &&
    (run.reviewAction === 'merge' || run.reviewAction === 'pr')
  );
}

// Whether a merged run's landing has reached origin. A PR merge happened ON
// origin, so it is pushed by definition; a no-op merge produced no commit, so
// there is nothing left to push; a real local merge is answered by the
// server-decorated pushedToOrigin probe of its recorded merge commit.
function isPushedRun(run: RunMeta): boolean {
  if (run.reviewAction === 'pr') return true;
  if (run.mergeCommit === undefined) return true;
  return run.pushedToOrigin === true;
}

/**
 * The Landed page's whole data join, in one pass.
 *
 * The two sides answer different halves of "what landed and what is still
 * out": git's ref list can only describe still-out work, because a successful
 * merge review DELETES the ref — so the landed half has to come from the run
 * registry, which remembers merged runs forever. Archived runs are the one
 * exception: archiving is the existing "this landed and reached origin, stop
 * showing it" signal, so they leave this surface too.
 *
 * Deduped by branch for the leftover case (a merged run whose ref survived a
 * failed cleanup): the run row tells that branch's story with the review
 * attached, so the surviving ref must not land a second row.
 */
export function buildLandedBuckets(
  branches: BranchEntry[],
  runs: RunMeta[]
): Record<LandedBucketId, LandedRow[]> {
  const buckets: Record<LandedBucketId, LandedRow[]> = {
    'awaiting-review': [],
    'in-progress': [],
    abandoned: [],
    'merged-local': [],
    'merged-pushed': [],
  };

  // Newest merged run per branch: resume chains legitimately produce several
  // runs on one branch, and one landing must not render as two.
  const mergedRunByBranch = new Map<string, RunMeta>();
  for (const run of runs) {
    if (!isMergedRun(run) || run.archivedAt !== undefined) continue;
    const existing = mergedRunByBranch.get(run.branch);
    if (existing === undefined || run.createdAt >= existing.createdAt) {
      mergedRunByBranch.set(run.branch, run);
    }
  }

  for (const entry of branches) {
    const bucket = landedBucketOf(entry);
    const isMergedBucket =
      bucket === 'merged-local' || bucket === 'merged-pushed';
    if (isMergedBucket && mergedRunByBranch.has(entry.branch)) continue;
    buckets[bucket].push({
      key: entry.branch,
      branch: entry.branch,
      baseBranch: entry.baseBranch,
      taskTitle: entry.taskTitle,
      runId: entry.runId,
      behindBase: entry.behindBase,
      lastCommitAt: entry.lastCommitAt,
      reviewedAt: entry.reviewedAt,
      dirty: entry.dirty,
    });
  }

  for (const run of mergedRunByBranch.values()) {
    buckets[isPushedRun(run) ? 'merged-pushed' : 'merged-local'].push({
      key: run.id,
      branch: run.branch,
      baseBranch: run.baseBranch,
      taskTitle: run.taskTitle,
      runId: run.id,
      reviewedAt: run.reviewedAt,
      dirty: false,
    });
  }

  // Still-out sections keep the server's urgency order; landed sections read
  // newest landing first, which is the question "what just went in".
  const byReviewedDesc = (a: LandedRow, b: LandedRow): number =>
    (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '');
  buckets['merged-local'].sort(byReviewedDesc);
  buckets['merged-pushed'].sort(byReviewedDesc);
  return buckets;
}

/** Whether a still-out row has sat untouched long enough to flag — the same
 * one-week line the Git page's health pass draws (STALE_AFTER_MS). */
export function isStaleBranch(
  row: Pick<LandedRow, 'lastCommitAt'>,
  now: number = Date.now()
): boolean {
  if (row.lastCommitAt === undefined) return false;
  const at = Date.parse(row.lastCommitAt);
  return Number.isFinite(at) && now - at > STALE_AFTER_MS;
}
