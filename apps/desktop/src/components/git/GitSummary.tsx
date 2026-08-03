import type { BranchEntry } from '@dispatch/client';
import { useMemo } from 'react';

import { formatBytes } from '../../lib/formatBytes';
import type { GitFilter, GitHealth } from '../../lib/gitHealth';
import { computeGitHealth } from '../../lib/gitHealth';
import { cn } from '@/lib/utils';

interface GitSummaryProps {
  branches: BranchEntry[];
  /** Skips this component's own `computeGitHealth` pass when the caller already has one
   * (e.g. it also needs the same health data for its own rendering). */
  health?: GitHealth;
  /** Reclaims every worktree that is safe to reclaim, in one go. */
  onReclaimMerged: () => void;
  /** Filters the list below to one bucket, so a count is a way in and not a fact. */
  onFocus: (filter: GitFilter) => void;
  active: GitFilter;
  reclaiming?: boolean;
}

export type { GitFilter };

/** What git is costing you, above the list of branches. Every number is also a filter, so a
 *  count is a way into the rows behind it rather than a readout you then have to act on. */
export function GitSummary({
  branches,
  health: precomputedHealth,
  onReclaimMerged,
  onFocus,
  active,
  reclaiming = false,
}: GitSummaryProps) {
  const health = useMemo(
    () => precomputedHealth ?? computeGitHealth(branches),
    [precomputedHealth, branches]
  );

  return (
    <div className="border-border flex flex-wrap items-center gap-x-1 gap-y-0.5 rounded-lg border px-1.5 py-1">
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
        <button
          type="button"
          disabled={reclaiming}
          onClick={onReclaimMerged}
          title={`${formatBytes(health.reclaimableBytes)} in ${health.reclaimable.length} merged worktree${health.reclaimable.length === 1 ? '' : 's'}`}
          className="border-border hover:bg-accent rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
        >
          {reclaiming
            ? 'Reclaiming…'
            : `Reclaim ${formatBytes(health.reclaimableBytes)}`}
        </button>
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
          'font-mono text-[12px] leading-tight',
          tone === 'warn' && 'text-state-waiting',
          tone === 'bad' && 'text-state-failed'
        )}
      >
        {value}
      </span>
      <span className="dense-meta">{label}</span>
    </>
  );

  // A count with nothing behind it is not a button. Rendering it as one would
  // promise a filter that shows an empty list.
  if (onClick === undefined) {
    return (
      <div className="flex items-baseline gap-1 px-1 py-0.5" title={hint}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={hint}
      className={cn(
        'hover:bg-accent/60 flex items-baseline gap-1 rounded-md px-1 py-0.5 text-left transition-colors duration-150',
        selected && 'bg-accent'
      )}
    >
      {body}
    </button>
  );
}
