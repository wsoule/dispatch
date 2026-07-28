import type { BranchEntry } from '@dispatch/client';
import { useMemo } from 'react';

import { formatBytes } from '../../lib/formatBytes';
import { computeGitHealth } from '../../lib/gitHealth';
import { cn } from '@/lib/utils';

interface GitSummaryProps {
  branches: BranchEntry[];
  /** Reclaims every worktree that is safe to reclaim, in one go. */
  onReclaimMerged: () => void;
  /** Filters the list below to one bucket, so a count is a way in and not a fact. */
  onFocus: (filter: GitFilter) => void;
  active: GitFilter;
  reclaiming?: boolean;
}

export type GitFilter = 'all' | 'stale' | 'orphans' | 'dirty' | 'stacked';

/**
 * What git is actually costing you, above the list of branches.
 *
 * Dispatch creates a full checkout per run and the only prior signal that they
 * existed was a row in a list — one of the captures in this project's own inbox
 * is literally "worktree disk usage is not reported anywhere".
 *
 * Every number here is a filter, not a readout. A count you cannot act on just
 * moves the work of finding the rows back onto you, which is the same problem
 * as not showing the count at all.
 */
export function GitSummary({
  branches,
  onReclaimMerged,
  onFocus,
  active,
  reclaiming = false,
}: GitSummaryProps) {
  const health = useMemo(() => computeGitHealth(branches), [branches]);

  return (
    <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border px-3 py-2.5">
      <Stat
        label="Branches"
        value={String(health.branches)}
        onClick={() => onFocus('all')}
        selected={active === 'all'}
      />
      <Stat
        label="On disk"
        value={formatBytes(health.totalBytes)}
        hint={`${health.onDisk.length} worktree${health.onDisk.length === 1 ? '' : 's'}`}
      />
      <Stat
        label="Stale"
        value={String(health.stale.length)}
        hint={
          health.staleBytes > 0 ? formatBytes(health.staleBytes) : undefined
        }
        tone={health.stale.length > 0 ? 'warn' : undefined}
        onClick={health.stale.length > 0 ? () => onFocus('stale') : undefined}
        selected={active === 'stale'}
      />
      <Stat
        label="Orphaned"
        value={String(health.orphans.length)}
        tone={health.orphans.length > 0 ? 'bad' : undefined}
        onClick={
          health.orphans.length > 0 ? () => onFocus('orphans') : undefined
        }
        selected={active === 'orphans'}
      />
      <Stat
        label="Uncommitted"
        value={String(health.dirty)}
        tone={health.dirty > 0 ? 'warn' : undefined}
        onClick={health.dirty > 0 ? () => onFocus('dirty') : undefined}
        selected={active === 'dirty'}
      />
      <Stat
        label="Stacked"
        value={String(health.stacked.length)}
        onClick={
          health.stacked.length > 0 ? () => onFocus('stacked') : undefined
        }
        selected={active === 'stacked'}
      />

      <span className="flex-1" />

      {health.reclaimable.length > 0 && (
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground text-[12px]">
            {formatBytes(health.reclaimableBytes)} in{' '}
            {health.reclaimable.length} merged worktree
            {health.reclaimable.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            disabled={reclaiming}
            onClick={onReclaimMerged}
            className="border-border hover:bg-accent rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50"
          >
            {reclaiming ? 'Reclaiming…' : 'Reclaim'}
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
  onClick,
  selected = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn' | 'bad';
  onClick?: () => void;
  selected?: boolean;
}) {
  const body = (
    <>
      <span
        className={cn(
          'font-mono text-[15px] leading-tight',
          tone === 'warn' && 'text-state-waiting',
          tone === 'bad' && 'text-state-failed'
        )}
      >
        {value}
      </span>
      <span className="dense-meta">
        {label}
        {hint !== undefined && ` · ${hint}`}
      </span>
    </>
  );

  // A count with nothing behind it is not a button. Rendering it as one would
  // promise a filter that shows an empty list.
  if (onClick === undefined) {
    return <div className="flex flex-col px-2 py-0.5">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'hover:bg-accent/60 flex flex-col rounded-md px-2 py-0.5 text-left transition-colors duration-150',
        selected && 'bg-accent'
      )}
    >
      {body}
    </button>
  );
}
