import type { BranchEntry } from '@dispatch/client';
import { useMemo } from 'react';

import { formatBytes } from '../../lib/formatBytes';
import type { GitFilter, GitHealth } from '../../lib/gitHealth';
import { computeGitHealth } from '../../lib/gitHealth';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

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
      {/* `type="multiple"` because the chips are laid out flat, not as a mutually exclusive
          radio strip — `value` only ever holds the one active filter, and each chip's own
          `onClick` (not the group's `onValueChange`) is what drives `onFocus`. */}
      <ToggleGroup type="multiple" value={[active]} className="contents">
        <Stat
          label="Branches"
          value={String(health.branches)}
          filterValue="all"
          onClick={() => onFocus('all')}
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
          filterValue={health.stale.length > 0 ? 'stale' : undefined}
          onClick={health.stale.length > 0 ? () => onFocus('stale') : undefined}
        />
        <Stat
          label="Orphaned"
          value={String(health.orphans.length)}
          tone={health.orphans.length > 0 ? 'bad' : undefined}
          filterValue={health.orphans.length > 0 ? 'orphans' : undefined}
          onClick={
            health.orphans.length > 0 ? () => onFocus('orphans') : undefined
          }
        />
        <Stat
          label="Uncommitted"
          value={String(health.dirty)}
          tone={health.dirty > 0 ? 'warn' : undefined}
          filterValue={health.dirty > 0 ? 'dirty' : undefined}
          onClick={health.dirty > 0 ? () => onFocus('dirty') : undefined}
        />
        <Stat
          label="Stacked"
          value={String(health.stacked.length)}
          filterValue={health.stacked.length > 0 ? 'stacked' : undefined}
          onClick={
            health.stacked.length > 0 ? () => onFocus('stacked') : undefined
          }
        />
      </ToggleGroup>

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
  filterValue,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn' | 'bad';
  onClick?: () => void;
  /** The `GitFilter` this chip toggles to — undefined keeps it a plain, non-interactive
   * readout (see the comment below). */
  filterValue?: GitFilter;
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
  if (onClick === undefined || filterValue === undefined) {
    return (
      <div className="flex items-baseline gap-1 px-1 py-0.5" title={hint}>
        {body}
      </div>
    );
  }
  return (
    <ToggleGroupItem
      value={filterValue}
      onClick={onClick}
      title={hint}
      // `ToggleGroupItem`'s own size/weight/hover classes are for a taller, bolder toggle
      // button — every one that would change this chip's look is neutralized so pressed
      // state (now real radix `data-state`/`aria-pressed`) is the only thing that moved.
      className="hover:bg-accent/60 h-auto min-w-0 justify-normal gap-1 rounded-md px-1 py-0.5 text-left text-xs font-normal whitespace-normal normal-case transition-colors duration-150 hover:text-inherit data-[state=on]:text-inherit"
    >
      {body}
    </ToggleGroupItem>
  );
}
