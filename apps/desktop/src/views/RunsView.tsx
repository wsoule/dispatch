import { GitBranch, MousePointerClick } from 'lucide-react';

import { RunLogView } from '../components/runs/RunLogView';
import { RunReviewView } from '../components/runs/RunReviewView';
import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTerminalRunState } from '../lib/runState';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/ui/skeleton';

interface RunsViewProps {
  data: DispatchProjectData;
  /** The single source of truth for which run is open — `navReducer`'s `activeRunId` (see
   * C1 in the phase-8 fix report: this view used to read/write its own copy of "selected
   * run" via a `useDispatchProject`-internal `selectedRunId` state that nothing else in the
   * app ever wrote to, so opening a run from the task peek panel updated nav state but left
   * this view still pointed at whatever it had selected last, or nothing at all). */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

/**
 * Split layout per the redesign brief: every run for this project down the left (newest
 * first, state dot + task + ticking cost), the selected run's full surface on the right —
 * `RunLogView`'s chat-style log/approval-banner/follow-up-composer while live, or
 * `RunReviewView`'s Pierre diff + file tree + merge/discard/request-changes/PR once it's
 * finished — swapped in place on `meta.state`, exactly like the old `RunModal` did, just
 * inline in a page instead of inside a dialog.
 */
export function RunsView({ data, selectedRunId, onSelectRun }: RunsViewProps) {
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const selected = data.runs.find((r) => r.id === selectedRunId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="view-topbar-title">Runs</h1>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="border-border flex w-72 shrink-0 flex-col gap-1 overflow-y-auto border-r pr-3">
          {data.tasksLoading ? (
            <div className="flex flex-col gap-2 p-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : data.runs.length === 0 ? (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <GitBranch className="size-5" />
              <p className="text-[13px]">
                No runs yet — dispatch a ready task from the Board to start one.
              </p>
            </div>
          ) : (
            data.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors duration-150',
                  run.id === selectedRunId
                    ? 'border-border bg-accent'
                    : 'hover:bg-muted/60'
                )}
              >
                <RunStatePill state={run.state} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {run.taskTitle}
                </span>
                {run.costUsd !== undefined && (
                  <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                    ${run.costUsd.toFixed(2)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected === undefined ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
              <MousePointerClick className="size-5" />
              <p className="text-[13px]">
                Select a run on the left to see its log or review its result.
              </p>
            </div>
          ) : data.runDetail === undefined ? (
            <div className="flex flex-col gap-3 p-1">
              <Skeleton className="h-6 w-48 rounded-md" />
              <Skeleton className="h-32 rounded-md" />
              <Skeleton className="h-32 rounded-md" />
            </div>
          ) : isTerminalRunState(selected.state) ? (
            <RunReviewView
              meta={data.runDetail.meta}
              diff={data.diff}
              diffLoading={data.diffLoading}
              diffError={data.diffError}
              prCapability={data.health?.pr ?? false}
              onMerge={() => data.handleReview(selected.id, 'merge')}
              onDiscard={() => data.handleReview(selected.id, 'discard')}
              onRequestChanges={(text) =>
                data.handleRequestChanges(selected.id, text)
              }
              onOpenPr={() => data.handleOpenPr(selected.id)}
            />
          ) : (
            <RunLogView
              meta={data.runDetail.meta}
              entries={data.runDetail.entries}
              pendingApproval={data.pendingApprovals.get(selected.id) ?? null}
              onApprove={(requestId, allow) =>
                data.handleApprove(selected.id, requestId, allow)
              }
              onSendMessage={(text) =>
                data.handleSendMessage(selected.id, text)
              }
              onCancel={() => data.handleCancelRun(selected.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
