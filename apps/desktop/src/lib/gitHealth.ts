import type { BranchEntry } from '@dispatch/client';

/**
 * How long a worktree sits untouched before it is worth pointing at.
 *
 * A week, because that is roughly when a checkout stops being "the thing I am
 * working on" and starts being something you forgot. Shorter and every active
 * branch nags; longer and the disk is already gone.
 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface GitHealth {
  /** Every branch, including refs with no worktree left. */
  branches: number;
  /** Worktrees actually present on disk — the ones costing anything. */
  onDisk: BranchEntry[];
  totalBytes: number;
  /** Safe to reclaim: landed, and nothing uncommitted inside. */
  reclaimable: BranchEntry[];
  reclaimableBytes: number;
  /** On disk, untouched for longer than STALE_AFTER_MS. */
  stale: BranchEntry[];
  staleBytes: number;
  /** Refs nothing owns any more — no automatic path will ever clean these up. */
  orphans: BranchEntry[];
  /** Worktrees with uncommitted changes, which no bulk action may touch. */
  dirty: number;
  /** Stacked on another branch's unmerged work, so not independently removable. */
  stacked: BranchEntry[];
}

const bytesOf = (entries: BranchEntry[]): number =>
  entries.reduce((sum, e) => sum + (e.diskBytes ?? 0), 0);

/**
 * One pass over the branch list, producing every number the Git page reports.
 *
 * Pure and separate from the view so the definitions are testable and stated
 * once — "reclaimable" in particular means two things at the same time
 * (already landed AND nothing uncommitted), and a definition like that drifts
 * the moment it is re-derived inline in a second place.
 */
export function computeGitHealth(
  branches: BranchEntry[],
  now: number = Date.now()
): GitHealth {
  const onDisk = branches.filter((b) => b.worktreeExists);
  const reclaimable = onDisk.filter((b) => b.mergedIntoBase && !b.dirty);
  const stale = onDisk.filter((b) => {
    if (b.lastCommitAt === undefined) return false;
    const at = Date.parse(b.lastCommitAt);
    return Number.isFinite(at) && now - at > STALE_AFTER_MS;
  });

  return {
    branches: branches.length,
    onDisk,
    totalBytes: bytesOf(onDisk),
    reclaimable,
    reclaimableBytes: bytesOf(reclaimable),
    stale,
    staleBytes: bytesOf(stale),
    // 'leftover' sits with 'orphan': the run was already reviewed, so nothing
    // owns the ref and no automatic path will reclaim it either.
    orphans: branches.filter(
      (b) => b.status === 'orphan' || b.status === 'leftover'
    ),
    dirty: onDisk.filter((b) => b.dirty).length,
    stacked: branches.filter(
      (b) => b.stackParents !== undefined && b.stackParents.length > 0
    ),
  };
}
