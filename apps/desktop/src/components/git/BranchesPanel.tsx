import type { BranchEntry, BranchEntryStatus } from '@dispatch/client';
import { Bot, Check, GitBranch, Sparkles } from 'lucide-react';
import { useMemo } from 'react';

import { GitSummary } from './GitSummary';
import { formatRelativeTimeFromIso } from '@/lib/format';
import type { BranchRowVM } from '@/lib/gitBranchRows';
import { canActOnBranchRow } from '@/lib/gitBranchRows';
import type { GitFilter } from '@/lib/gitHealth';
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
  onDeleteAllMergedOrphans: () => void;
  onSelectIndex: (index: number) => void;
  onOpenRun: (runId: string) => void;
  onDispatchAgent: (branch: string) => void;
}

/** Panel 3: every branch git knows about, dispatch ones badged with their run/task, plus
 * dispatch's worktree health chips and reclaim/bulk-cleanup actions. */
export function BranchesPanel({
  rows,
  worktrees,
  selectedIndex,
  filter,
  onFilterChange,
  reclaiming,
  onReclaimMerged,
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
        health={health}
        reclaiming={reclaiming}
        onReclaimMerged={onReclaimMerged}
        active={filter}
        onFocus={onFilterChange}
      />
      {health.mergedOrphans.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          className="self-start"
          onClick={onDeleteAllMergedOrphans}
        >
          Delete {health.mergedOrphans.length} merged orphan
          {health.mergedOrphans.length === 1 ? '' : 's'}
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
            const canAct = canActOnBranchRow(row);
            return (
              <div
                key={row.name}
                data-git-selected={index === selectedIndex ? 'true' : undefined}
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenRun(row.runId);
                      }}
                      // `size="xs"` sets its own `h-6`/`text-xs` — both cancelled (`h-auto`,
                      // `text-[length:inherit]`) so this restores the parent row's inherited
                      // 11px instead of picking up either the xs size's 12px or Button's
                      // default 14px.
                      className="hover:text-foreground h-auto p-0 font-mono text-[length:inherit] font-normal underline-offset-2 hover:bg-transparent hover:underline"
                    >
                      {row.runId}
                    </Button>
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
