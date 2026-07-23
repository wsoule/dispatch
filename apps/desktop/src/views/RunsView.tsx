import { FileX, GitBranch, MousePointerClick } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { RunDetailHeader } from '../components/runs/RunDetailHeader';
import { RunLogView } from '../components/runs/RunLogView';
import { RunReviewView } from '../components/runs/RunReviewView';
import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { StackBadge, StackRail } from '../components/tasks/StackRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useResizablePane } from '../hooks/useResizablePane';
import { liveCostUsd } from '../lib/runLog';
import { isTerminalRunState } from '../lib/runState';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';

type RunTab = 'session' | 'diff';

// The run-list column's width before any manual resize, and what double-clicking the drag
// handle resets it back to — matches the old fixed `w-72`.
const DEFAULT_RUN_LIST_WIDTH = 288;

// A muted centered placeholder for the Diff tab when there's nothing to review yet — a run
// that's still going (no worktree diff exposed until it's terminal) or a terminal run whose
// worktree/diff is gone (already reviewed, or genuinely nothing changed).
function DiffEmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
      <FileX className="size-5" />
      <p className="text-[13px]">{message}</p>
    </div>
  );
}

interface RunsViewProps {
  data: DispatchProjectData;
  /** The single source of truth for which run is open — `navReducer`'s `activeRunId` (see
   * C1 in the phase-8 fix report: this view used to read/write its own copy of "selected
   * run" via a `useDispatchProject`-internal `selectedRunId` state that nothing else in the
   * app ever wrote to, so opening a run from the task peek panel updated nav state but left
   * this view still pointed at whatever it had selected last, or nothing at all). */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** Opens the Pull requests tab focused on a given run's PR — the run Review surface only
   * links to PR review, it doesn't host it. */
  onViewPr: (runId: string) => void;
}

/**
 * Split layout: every run for this project down the left (newest first, state dot + task +
 * ticking cost), the selected run's full surface on the right — a shared header (state, cost,
 * cancel) above a `Tabs` with a **Session** tab (the transcript, always available, with a
 * composer that talks to a live agent or requests changes on a terminal one) and a **Diff**
 * tab (the Pierre diff/file-tree + merge/discard/PR, once the run actually has changes to
 * review). Per the "see the session and talk to it" brief, a finished run no longer jumps
 * straight to the diff — Session stays reachable (and is the default) for any run that hasn't
 * produced changes worth reviewing.
 */
export function RunsView({
  data,
  selectedRunId,
  onSelectRun,
  onViewPr,
}: RunsViewProps) {
  const [tab, setTab] = useState<RunTab>('session');
  // Which run id the tab above was last defaulted for — a default is only applied once per
  // run (on first seeing it, or once its diff resolves), so switching tabs manually never
  // gets clobbered by a later poll of the same run's data.
  const defaultedRunIdRef = useRef<string | null>(null);

  // The split container the run-list column and drag handle live in — its width is the
  // clamp ceiling for the resize (the list can take at most half of it).
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    width: listWidth,
    onPointerDown: onResizePointerDown,
    onPointerMove: onResizePointerMove,
    onPointerUp: onResizePointerUp,
    onDoubleClick: onResizeDoubleClick,
  } = useResizablePane(
    'dispatch:runs-list-width',
    DEFAULT_RUN_LIST_WIDTH,
    splitRef
  );

  const selected = data.runs.find((r) => r.id === selectedRunId);
  const selectedId = selected?.id;
  const selectedState = selected?.state;
  const runDetail = data.runDetail;
  const diffLoading = data.diffLoading;
  const diff = data.diff;

  // Built once per `data.tasks`/`data.epics` change rather than re-scanned per row: a run
  // row's epic breadcrumb needs its task's `parent`, then that parent id's title.
  const taskById = useMemo(
    () => new Map(data.tasks.map((t) => [t.meta.id, t])),
    [data.tasks]
  );
  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of data.epics) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [data.epics]);

  useEffect(() => {
    if (selectedId === undefined || selectedState === undefined) return;
    if (defaultedRunIdRef.current === selectedId) return;
    if (!isTerminalRunState(selectedState)) {
      setTab('session');
      defaultedRunIdRef.current = selectedId;
      return;
    }
    // Terminal: the diff query only *enables* once `runDetail` itself has resolved as
    // terminal (see useDispatchProject's `diffEnabled`) — waiting on `diffLoading` alone
    // races that gate, since a disabled query reports `isLoading: false` the same as a
    // settled one. Wait for this run's own detail first, then for the (now-enabled) diff
    // query to settle, so a run with real changes doesn't flash Session before flipping to
    // Diff.
    if (runDetail === undefined || runDetail.meta.id !== selectedId) return;
    if (diffLoading) return;
    const hasChanges = diff !== undefined && diff.files.length > 0;
    setTab(hasChanges ? 'diff' : 'session');
    defaultedRunIdRef.current = selectedId;
  }, [selectedId, selectedState, runDetail, diffLoading, diff]);

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
      <h1 className="view-topbar-title">Runs</h1>
      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div
          className="flex shrink-0 flex-col gap-1 overflow-y-auto pr-3"
          style={{ width: listWidth }}
        >
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
            data.runs.map((run) => {
              const task = taskById.get(run.taskId);
              const epicTitle =
                task?.meta.parent != null
                  ? epicTitleById.get(task.meta.parent)
                  : undefined;
              return (
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
                    {epicTitle !== undefined && (
                      <span className="text-muted-foreground">
                        {' '}
                        › {epicTitle}
                      </span>
                    )}
                  </span>
                  <StackBadge tasks={data.tasks} taskId={run.taskId} />
                  {run.costUsd !== undefined && (
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                      ${run.costUsd.toFixed(2)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Drag handle: pointer-based resize rather than a CSS `resize` handle, so the width
            can be clamped to the container and persisted across reloads (see
            useResizablePane). The visible line sits on an invisible wider hit target so it's
            easy to grab without a pixel-perfect cursor. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize run list"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onDoubleClick={onResizeDoubleClick}
          className="group relative w-2 shrink-0 cursor-col-resize touch-none"
        >
          <div className="bg-border group-hover:bg-primary/50 absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col pl-1">
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
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <RunDetailHeader
                meta={data.runDetail.meta}
                cost={liveCostUsd(data.runDetail.meta, data.runDetail.entries)}
                live={!isTerminalRunState(selected.state)}
                onCancel={() => data.handleCancelRun(selected.id)}
              />

              <StackRail
                tasks={data.tasks}
                taskId={selected.taskId}
                latestRunByTaskId={data.latestRunByTaskId}
                onOpenTask={(taskId) => {
                  const run = data.latestRunByTaskId.get(taskId);
                  if (run !== undefined) onSelectRun(run.id);
                }}
              />

              <Tabs
                value={tab}
                onValueChange={(value) => setTab(value as RunTab)}
                className="flex min-h-0 flex-1 flex-col gap-3"
              >
                <TabsList className="self-start">
                  <TabsTrigger value="session">Session</TabsTrigger>
                  <TabsTrigger value="diff">Diff</TabsTrigger>
                </TabsList>

                <TabsContent value="session" className="min-h-0">
                  <RunLogView
                    meta={data.runDetail.meta}
                    entries={data.runDetail.entries}
                    pendingApproval={
                      data.pendingApprovals.get(selected.id) ?? null
                    }
                    onApprove={(requestId, allow) =>
                      data.handleApprove(selected.id, requestId, allow)
                    }
                    onSendMessage={(text) =>
                      data.handleSendMessage(selected.id, text)
                    }
                    onRequestChanges={(text) =>
                      data.handleRequestChanges(selected.id, text)
                    }
                  />
                </TabsContent>

                <TabsContent value="diff" className="min-h-0">
                  {!isTerminalRunState(selected.state) ? (
                    <DiffEmptyState message="No diff to review yet — check back once the run finishes." />
                  ) : data.diffError !== null ? (
                    <DiffEmptyState message="This run has no changes to review." />
                  ) : (
                    <RunReviewView
                      meta={data.runDetail.meta}
                      diff={data.diff}
                      diffLoading={data.diffLoading}
                      diffError={data.diffError}
                      prCapability={data.health?.pr ?? false}
                      mergeQueue={data.mergeQueue}
                      onMerge={() => data.handleReview(selected.id, 'merge')}
                      onDiscard={() =>
                        data.handleReview(selected.id, 'discard')
                      }
                      onRequestChanges={(text) =>
                        data.handleRequestChanges(selected.id, text)
                      }
                      onOpenPr={() => data.handleOpenPr(selected.id)}
                      onViewPr={() => onViewPr(selected.id)}
                      onQueueMerge={() => data.handleEnqueueMerge(selected.id)}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
