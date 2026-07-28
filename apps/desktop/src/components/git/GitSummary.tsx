import type { BranchEntry } from '@dispatch/client';

import { formatBytes } from '../../lib/formatBytes';
import { cn } from '@/lib/utils';

interface GitSummaryProps {
  branches: BranchEntry[];
  /** Reclaims every worktree that is safe to reclaim, in one go. */
  onReclaimMerged?: () => void;
  reclaiming?: boolean;
}

/**
 * What git is actually costing you, above the list of branches.
 *
 * Dispatch creates a full checkout per run and the only prior signal that they
 * existed was a row in a list — one of the captures in this project's own inbox
 * is literally "worktree disk usage is not reported anywhere". A count of
 * branches does not tell you that twelve gigabytes are sitting in worktrees for
 * work that already merged.
 *
 * The reclaimable figure is deliberately separate from the total: it is the
 * number that answers "can I get anything back", and it only counts worktrees
 * whose branch has already landed, so acting on it cannot lose work.
 */
export function GitSummary({
  branches,
  onReclaimMerged,
  reclaiming = false,
}: GitSummaryProps) {
  const onDisk = branches.filter((b) => b.worktreeExists);
  const totalBytes = onDisk.reduce((sum, b) => sum + (b.diskBytes ?? 0), 0);

  // Safe to reclaim: the work is on the base branch already, and nothing is
  // uncommitted in the worktree. Both conditions, because either alone can
  // still be holding something you have not saved.
  const reclaimable = onDisk.filter((b) => b.mergedIntoBase && !b.dirty);
  const reclaimableBytes = reclaimable.reduce(
    (sum, b) => sum + (b.diskBytes ?? 0),
    0
  );
  const dirty = onDisk.filter((b) => b.dirty).length;

  return (
    <div className="border-border flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-4 py-3">
      <Stat label="Branches" value={String(branches.length)} />
      <Stat label="Worktrees" value={String(onDisk.length)} />
      <Stat label="On disk" value={formatBytes(totalBytes)} />
      <Stat
        label="Uncommitted"
        value={String(dirty)}
        tone={dirty > 0 ? 'warn' : undefined}
      />
      <span className="flex-1" />
      {reclaimable.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-[12px]">
            {formatBytes(reclaimableBytes)} in {reclaimable.length} merged
            worktree{reclaimable.length === 1 ? '' : 's'}
          </span>
          {onReclaimMerged !== undefined && (
            <button
              type="button"
              disabled={reclaiming}
              onClick={onReclaimMerged}
              className="border-border hover:bg-accent rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50"
            >
              {reclaiming ? 'Reclaiming…' : 'Reclaim'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn';
}) {
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          'font-mono text-[15px]',
          tone === 'warn' && 'text-state-waiting'
        )}
      >
        {value}
      </span>
      <span className="dense-meta">{label}</span>
    </div>
  );
}
