import type {
  BranchEntry,
  BranchEntryStatus,
  GitBranchWithRun,
} from '@dispatch/client';
import { Bot, Check, GitBranch, Sparkles } from 'lucide-react';
import { useMemo } from 'react';

import type { GitFilter } from './GitSummary';
import { GitSummary } from './GitSummary';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { computeGitHealth } from '@/lib/gitHealth';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

const STATUS_CHIP: Record<BranchEntryStatus, { label: string; cls: string }> = {
  active: {
    label: 'Live',
    cls: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  },
  reviewable: {
    label: 'Unreviewed',
    cls: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  },
  leftover: {
    label: 'Cleanup failed',
    cls: 'border-red-500/40 text-red-600 dark:text-red-400',
  },
  orphan: {
    label: 'Orphan',
    cls: 'border-muted-foreground/40 text-muted-foreground',
  },
};

// How urgently a row deserves attention, lowest first — mirrors the old BranchesView's
// orphaned/leftover-worst, then-reviewable, then-active ordering.
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

/** Narrows `rows` to one `GitSummary` bucket, by branch name, so a health chip's count and the
 * rows it reveals can never disagree — mirrors the old BranchesView's `matchesFilter`. */
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

interface BranchesPanelProps {
  rows: BranchRowVM[];
  /** Always the full unfiltered set, so GitSummary's health chips never change as the list
   * itself is filtered. */
  worktrees: BranchEntry[];
  selectedIndex: number;
  filter: GitFilter;
  onFilterChange: (filter: GitFilter) => void;
  reclaiming: boolean;
  onReclaimMerged: () => void;
  /** Every orphan whose commits already landed on its base — safe to delete in bulk. */
  mergedOrphans: BranchEntry[];
  onDeleteAllMergedOrphans: () => void;
  onSelectIndex: (index: number) => void;
  onOpenRun: (runId: string) => void;
  onDispatchAgent: (branch: string) => void;
}

/** Panel 3: every branch git knows about, dispatch ones badged with their run/task and the
 * same health chips/reclaim capabilities the old standalone Branches surface had. */
export function BranchesPanel({
  rows,
  worktrees,
  selectedIndex,
  filter,
  onFilterChange,
  reclaiming,
  onReclaimMerged,
  mergedOrphans,
  onDeleteAllMergedOrphans,
  onSelectIndex,
  onOpenRun,
  onDispatchAgent,
}: BranchesPanelProps) {
  const health = useMemo(() => computeGitHealth(worktrees), [worktrees]);

  return (
    <div className="flex flex-col gap-2 p-2">
      <GitSummary
        branches={worktrees}
        reclaiming={reclaiming}
        onReclaimMerged={onReclaimMerged}
        active={filter}
        onFocus={onFilterChange}
      />
      {mergedOrphans.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          className="self-start"
          onClick={onDeleteAllMergedOrphans}
        >
          Delete {mergedOrphans.length} merged orphan
          {mergedOrphans.length === 1 ? '' : 's'}
        </Button>
      )}
      {rows.length === 0 ? (
        <div className="text-muted-foreground p-2 text-[12px]">
          No branches match this filter.
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row, index) => {
            const chip =
              row.worktree !== undefined
                ? STATUS_CHIP[row.worktree.status]
                : null;
            const canAct =
              row.worktree === undefined || row.worktree.status !== 'active';
            return (
              <div
                key={row.name}
                onClick={() => onSelectIndex(index)}
                role="button"
                tabIndex={-1}
                className={cn(
                  'flex flex-col gap-1 rounded-md px-2 py-1.5',
                  index === selectedIndex ? 'bg-accent' : 'hover:bg-muted/50'
                )}
              >
                <div className="flex items-center gap-1.5">
                  {row.isCurrent ? (
                    <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="truncate font-mono text-[12px]">
                    {row.name}
                  </span>
                  {chip !== null && (
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium',
                        chip.cls
                      )}
                    >
                      {chip.label}
                    </span>
                  )}
                  {row.worktree?.dirty === true && (
                    <span
                      title="Uncommitted changes in this worktree"
                      className="shrink-0 rounded border border-orange-500/40 px-1.5 py-px text-[10px] font-medium text-orange-600 dark:text-orange-400"
                    >
                      Uncommitted
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground/80 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px]">
                  {row.taskTitle !== undefined && (
                    <span className="truncate">{row.taskTitle}</span>
                  )}
                  {row.runId !== undefined && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenRun(row.runId);
                      }}
                      className="hover:text-foreground font-mono underline-offset-2 hover:underline"
                    >
                      {row.runId}
                    </button>
                  )}
                  <span>{row.shortSha}</span>
                  <span className="truncate">{row.subject}</span>
                  <span>{formatRelativeTimeFromIso(row.date)}</span>
                </div>
                {canAct && (
                  <div className="pl-5">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDispatchAgent(row.name);
                      }}
                      title="Start an agent working from this branch"
                    >
                      <Bot className="size-3" />
                      Dispatch agent
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {health.orphans.length > 0 && (
        <div className="text-muted-foreground flex items-center gap-1.5 px-2 text-[11px]">
          <Sparkles className="size-3" />
          {health.orphans.length} orphaned worktree
          {health.orphans.length === 1 ? '' : 's'} — filter to “Orphaned” above
          to clean up.
        </div>
      )}
    </div>
  );
}
