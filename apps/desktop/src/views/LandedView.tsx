import { GitBranch, GitMerge, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { LandedBucketId, LandedRow } from '../lib/landedBuckets';
import {
  buildLandedBuckets,
  isStaleBranch,
  LANDED_BUCKET_ORDER,
} from '../lib/landedBuckets';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

interface LandedViewProps {
  data: DispatchProjectData;
  onOpenRun: (runId: string) => void;
}

/** Per-bucket copy and chip styling. The chip is the row's one-glance verdict,
 * so the two merged states deliberately do NOT share a color: landed-and-pushed
 * is green (done), landed-but-local is amber (one push from done). */
const BUCKET_UI: Record<
  LandedBucketId,
  { label: string; description: string; chip: string; chipCls: string }
> = {
  'awaiting-review': {
    label: 'Awaiting review',
    description: 'Finished runs whose work has not landed — review or discard.',
    chip: 'Needs review',
    chipCls: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  },
  'in-progress': {
    label: 'In progress',
    description: 'A live agent is still writing to these branches.',
    chip: 'Agent running',
    chipCls: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  },
  abandoned: {
    label: 'Abandoned',
    description:
      'Unmerged work no run owns any more — nothing will land these without you.',
    chip: 'Abandoned',
    chipCls: 'border-red-500/40 text-red-600 dark:text-red-400',
  },
  'merged-local': {
    label: 'Merged locally — not pushed',
    description:
      'Landed on the base branch, but the merge has not reached origin yet.',
    chip: 'Not pushed',
    chipCls: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  },
  'merged-pushed': {
    label: 'Merged & pushed',
    description: 'Landed on the base branch and on origin. Done.',
    chip: 'On origin',
    chipCls: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  },
};

/** The Landed page: every run branch, bucketed by whether its work reached the
 * project base branch (and origin), so "what landed and what is still out" is
 * one screen instead of a hand-run `git branch` + merge-base session. Landed
 * rows come from the run registry — a successful merge review deletes its ref,
 * so git alone cannot tell this story (see buildLandedBuckets). */
export function LandedView({ data, onOpenRun }: LandedViewProps) {
  const buckets = useMemo(
    () => buildLandedBuckets(data.branches, data.runs),
    [data.branches, data.runs]
  );
  const total = LANDED_BUCKET_ORDER.reduce(
    (sum, bucket) => sum + buckets[bucket].length,
    0
  );
  const stillOut =
    buckets['awaiting-review'].length +
    buckets['in-progress'].length +
    buckets.abandoned.length;

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="view-topbar-title">Landed</h1>
          {total > 0 && (
            <span className="text-muted-foreground text-[12px]">
              {stillOut === 0
                ? 'Everything has landed.'
                : `${stillOut} branch${stillOut === 1 ? '' : 'es'} still out`}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          onClick={() => void data.handleRefreshBranches()}
        >
          <RefreshCw
            className={cn('size-3.5', data.branchesLoading && 'animate-spin')}
          />
          Refresh
        </Button>
      </div>

      {total === 0 ? (
        // The first fetch and "genuinely nothing" both arrive as an empty
        // list; only claim there is nothing once the fetch has settled.
        data.branchesLoading ? (
          <div className="text-muted-foreground p-2 text-[12px]">
            Loading branches…
          </div>
        ) : (
          <EmptyState message="No run branches. Dispatch a task and its branch will show up here." />
        )
      ) : (
        <div className="scroll-affordance flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {LANDED_BUCKET_ORDER.map((bucket) => (
            <BucketSection
              key={bucket}
              bucket={bucket}
              rows={buckets[bucket]}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BucketSection({
  bucket,
  rows,
  onOpenRun,
}: {
  bucket: LandedBucketId;
  rows: LandedRow[];
  onOpenRun: (runId: string) => void;
}) {
  const ui = BUCKET_UI[bucket];
  return (
    <section>
      <div className="flex items-baseline gap-2 px-1 pb-1.5">
        <h2 className="text-[12px] font-medium">{ui.label}</h2>
        <span className="text-muted-foreground font-mono text-[12px]">
          {rows.length}
        </span>
        <span className="text-muted-foreground/80 truncate text-[11px]">
          {ui.description}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground/60 border-border rounded-md border border-dashed px-3 py-2 text-[12px]">
          None.
        </div>
      ) : (
        <div className="border-border divide-border divide-y rounded-md border">
          {rows.map((row) => (
            <BranchRow
              key={row.key}
              bucket={bucket}
              row={row}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BranchRow({
  bucket,
  row,
  onOpenRun,
}: {
  bucket: LandedBucketId;
  row: LandedRow;
  onOpenRun: (runId: string) => void;
}) {
  const ui = BUCKET_UI[bucket];
  const merged = bucket === 'merged-local' || bucket === 'merged-pushed';
  // Only a still-out branch is measured against the moving base; `undefined`
  // also covers a server predating the field, where claiming "0 behind"
  // would be an invented fact.
  const behind = merged ? undefined : row.behindBase;
  const stale = !merged && isStaleBranch(row);

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {merged ? (
            <GitMerge className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="truncate font-mono text-[12px]">{row.branch}</span>
          <span
            className={cn(
              'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium',
              ui.chipCls
            )}
          >
            {ui.chip}
          </span>
          {stale && (
            <span
              title="No commits for over a week"
              className="text-muted-foreground border-muted-foreground/40 shrink-0 rounded border px-1.5 py-px text-[10px] font-medium"
            >
              Stale
            </span>
          )}
          {row.dirty && (
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
              onClick={() => onOpenRun(row.runId)}
              // Neutralized like BranchesPanel's run link: inherit the row's
              // 11px instead of the xs size's 12px, and read as a link.
              className="hover:text-foreground h-auto p-0 font-mono text-[length:inherit] font-normal underline-offset-2 hover:bg-transparent hover:underline"
            >
              {row.runId}
            </Button>
          )}
        </div>
      </div>
      <div className="text-muted-foreground flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
        {behind !== undefined && (
          <span className={cn(behind > 0 && 'text-state-waiting')}>
            {behind === 0
              ? `up to date with ${row.baseBranch ?? 'base'}`
              : `${behind} commit${behind === 1 ? '' : 's'} behind ${row.baseBranch ?? 'base'}`}
          </span>
        )}
        {merged && row.reviewedAt !== undefined && (
          <span>reviewed {formatRelativeTimeFromIso(row.reviewedAt)}</span>
        )}
        {row.lastCommitAt !== undefined && (
          <span>last commit {formatRelativeTimeFromIso(row.lastCommitAt)}</span>
        )}
      </div>
    </div>
  );
}
