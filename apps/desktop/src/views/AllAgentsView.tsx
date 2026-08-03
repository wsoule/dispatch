import type { ApiClient, RunMeta } from '@dispatch/client';
import { Radio } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { deriveFeedState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import { modelDisplayName } from '../lib/models';
import { deriveRunDisposition } from '../lib/runState';
import { cn } from '@/lib/utils';
import { StateDot } from '@/ui/chrome/StateDot';
import { Skeleton } from '@/ui/skeleton';

interface AllAgentsViewProps {
  /** Every run for this project, newest-first — including terminal ones. This view used to
   * take only live runs, but the question it answers is "what has this repo actually done",
   * and a history that silently omits the runs you killed answers it dishonestly. */
  runs: RunMeta[];
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  client: ApiClient | null;
  onRetry: () => void;
  onJumpToRun: (runId: string) => void;
}

/** Columns, shared by the header strip and every row so the two cannot drift apart. */
const GRID =
  'grid grid-cols-[minmax(160px,1fr)_110px_64px_72px_88px_96px] items-center gap-3';

/** Runs whose row recedes: they are finished business, kept for the record. */
function isPast(run: RunMeta): boolean {
  const d = deriveRunDisposition(run);
  return d === 'closed' || run.state === 'cancelled';
}

/** How a terminal run ended, in a word. */
function outcomeLabel(run: RunMeta): string {
  if (run.state === 'cancelled') return 'killed';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'finished') {
    return run.reviewedAt !== undefined
      ? (run.reviewAction ?? 'closed')
      : 'finished';
  }
  return run.state;
}

/**
 * Every run this repo has had, including the ones you killed.
 *
 * A dense table rather than cards, because the value here is scanning down a column: turns and
 * spend line up so an outlier is visible without reading a single row. Terminal runs recede but
 * are never filtered out — a history that hides its failures is not a history.
 */
export function AllAgentsView({
  runs,
  portLoading,
  portError,
  portErrorDetail,
  client,
  onRetry,
  onJumpToRun,
}: AllAgentsViewProps) {
  const [showAll, setShowAll] = useState(false);

  // Newest first, so the run you just started is the one you are looking at.
  const ordered = useMemo(
    () => [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [runs]
  );
  const shown = showAll ? ordered : ordered.slice(0, 25);

  if (portLoading) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">All agents</h1>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">All agents</h1>
        <DaemonUnavailable
          starting={false}
          errorDetail={portErrorDetail}
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <h1 className="view-topbar-title">All agents</h1>
        <span className="text-muted-foreground text-[12px]">
          Every run this repo has had, including the ones you killed
        </span>
      </div>

      {ordered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Radio className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            No agents have run yet — dispatch a task from the board to start
            one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className={cn(GRID, 'dense-label px-3 pb-2')}>
            <span>Task</span>
            <span>Model</span>
            <span className="text-right">Turns</span>
            <span className="text-right">Spend</span>
            <span className="text-right">Updated</span>
            <span className="text-right">Outcome</span>
          </div>

          {shown.map((run) => {
            const state = deriveFeedState(run);
            const past = isPast(run);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onJumpToRun(run.id)}
                className={cn(
                  GRID,
                  'hover:bg-muted/40 rounded-md px-3 py-1.5 text-left transition-colors duration-150'
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/* A closed-out run has no feed state — it is nobody's turn — so it gets the
                      neutral blocked dot rather than being hidden or mislabelled. */}
                  <StateDot state={state ?? 'blocked'} />
                  <span
                    className={cn(
                      'truncate text-[13px]',
                      past ? 'text-muted-foreground' : 'text-foreground'
                    )}
                  >
                    {run.taskTitle}
                  </span>
                </span>
                <span className="dense-meta truncate">
                  {run.model === undefined ? '' : modelDisplayName(run.model)}
                </span>
                <span className="dense-meta text-right">{run.turns ?? ''}</span>
                <span className="dense-meta text-right">
                  {run.costUsd === undefined
                    ? ''
                    : `$${run.costUsd.toFixed(2)}`}
                </span>
                <span className="dense-meta text-right">
                  {formatRelativeTimeFromIso(run.updatedAt)}
                </span>
                <span
                  className={cn(
                    'dense-meta text-right',
                    run.state === 'failed' && 'text-state-failed'
                  )}
                >
                  {outcomeLabel(run)}
                </span>
              </button>
            );
          })}

          {ordered.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-muted-foreground hover:text-foreground px-3 py-2 text-left text-[12px]"
            >
              Show all {ordered.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
