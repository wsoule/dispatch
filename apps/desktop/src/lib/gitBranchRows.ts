import type {
  BranchEntry,
  BranchEntryStatus,
  GitBranchWithRun,
} from '@dispatch/client';

import type { GitFilter } from './gitHealth';
import { computeGitHealth } from './gitHealth';

// How urgently a row deserves attention, lowest first — orphaned/leftover worst, then
// reviewable, then active.
const STATUS_RANK: Record<BranchEntryStatus, number> = {
  orphan: 0,
  leftover: 0,
  reviewable: 1,
  active: 2,
};

export interface BranchRowVM {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  isDispatchBranch: boolean;
  shortSha: string;
  subject: string;
  date: string;
  ahead: number;
  behind: number;
  runId?: string;
  taskTitle?: string;
  worktree?: BranchEntry;
}

/** Joins the git-level branch list with dispatch's worktree bookkeeping by branch name, then
 * sorts current-branch-first and neediest-dispatch-branch-next. */
export function buildBranchRows(
  gitBranches: GitBranchWithRun[],
  worktrees: BranchEntry[]
): BranchRowVM[] {
  const worktreeByName = new Map(worktrees.map((w) => [w.branch, w]));
  const rows = gitBranches.map((b) => {
    const worktree = worktreeByName.get(b.name);
    return {
      name: b.name,
      isCurrent: b.isCurrent,
      isRemote: b.isRemote,
      isDispatchBranch: b.isDispatchBranch,
      shortSha: b.shortSha,
      subject: b.subject,
      date: b.date,
      ahead: b.ahead,
      behind: b.behind,
      runId: b.runId ?? worktree?.runId,
      taskTitle: b.taskTitle ?? worktree?.taskTitle,
      worktree,
    };
  });
  return rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const rankA = a.worktree !== undefined ? STATUS_RANK[a.worktree.status] : 3;
    const rankB = b.worktree !== undefined ? STATUS_RANK[b.worktree.status] : 3;
    if (rankA !== rankB) return rankA - rankB;
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** Whether delete/free-disk/discard may be offered for a row: never on a live
 *  run's worktree. Stated once so the list and detail pane can't disagree. */
export function canActOnBranchRow(row: BranchRowVM): boolean {
  return row.worktree === undefined || row.worktree.status !== 'active';
}

/** Whether the delete-branch confirm opens with "Force delete" pre-ticked —
 *  only for a known-unmerged branch, never for unknown merge status. */
export function forceDeleteDefault(row: BranchRowVM): boolean {
  return row.worktree?.mergedIntoBase === false;
}

/** Narrows `rows` to one `GitSummary` bucket, by branch name, so a health chip's count and
 * the rows it reveals can never disagree. */
export function filterBranchRows(
  rows: BranchRowVM[],
  worktrees: BranchEntry[],
  filter: GitFilter
): BranchRowVM[] {
  if (filter === 'all') return rows;
  const health = computeGitHealth(worktrees);
  const picked =
    filter === 'stale'
      ? health.stale
      : filter === 'orphans'
        ? health.orphans
        : filter === 'stacked'
          ? health.stacked
          : health.onDisk.filter((b) => b.dirty);
  const names = new Set(picked.map((b) => b.branch));
  return rows.filter((r) => names.has(r.name));
}
