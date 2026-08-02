import type { RunQuestion } from '@dispatch/client';
import {
  Archive,
  FileX,
  GitBranch,
  MousePointerClick,
  PanelRight,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { MergeLadderDot } from '../components/runs/MergeLadderDot';
import { RunDetailHeader } from '../components/runs/RunDetailHeader';
import { RunDiffView } from '../components/runs/RunDiffView';
import { RunKindBadge } from '../components/runs/RunKindBadge';
import { RunLogView } from '../components/runs/RunLogView';
import { RunReviewView } from '../components/runs/RunReviewView';
import { RunSidebar } from '../components/runs/RunSidebar';
import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { StackBadge, StackRail } from '../components/tasks/StackRail';
import { IconToggle } from '../components/ui/IconToggle';
import { Segmented } from '../components/ui/Segmented';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useResizablePane } from '../hooks/useResizablePane';
import { useScopeRequest } from '../hooks/useScopeRequest';
import { hideArchivedRuns } from '../lib/archiveFilter';
import { showArchiveToggle } from '../lib/archiveToggle';
import { countMergeReady } from '../lib/mergeReady';
import { liveCostUsd } from '../lib/runLog';
import { isTerminalRunState } from '../lib/runState';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

type RunTab = 'session' | 'diff';

// The run-list column's width before any manual resize, and what double-clicking the drag
// handle resets it back to — matches the old fixed `w-72`.
const DEFAULT_RUN_LIST_WIDTH = 288;

// Shared empty array so a run with no open questions keeps the same prop
// identity across renders.
const NO_QUESTIONS: RunQuestion[] = [];

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
  // The run's own metadata panel, off by default: the transcript is the thing
  // you came to read, and it was sharing the width with a sidebar nobody asked
  // for on every run.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Which run id the tab above was last defaulted for — a default is only applied once per
  // run (on first seeing it, or once its diff resolves), so switching tabs manually never
  // gets clobbered by a later poll of the same run's data.
  const defaultedRunIdRef = useRef<string | null>(null);

  // "Merge all ready" toolbar button state — disabled while the enqueue call
  // itself is in flight, on top of countMergeReady's own zero-count disable.
  const [mergeAllPending, setMergeAllPending] = useState(false);
  const queuedRunIds = useMemo(
    () => new Set((data.mergeQueue?.entries ?? []).map((e) => e.runId)),
    [data.mergeQueue]
  );
  const mergeReadyCount = useMemo(
    () => countMergeReady(data.runs, data.tasksIncludingArchived, queuedRunIds),
    [data.runs, data.tasksIncludingArchived, queuedRunIds]
  );
  // Also used as the push-failure banner's Retry action: re-invoking with
  // nothing left to enqueue still kicks the queue's pump, which retries a
  // failed drain-push (see useDispatchProject's handleMergeAllReady comment).
  const handleMergeAll = async () => {
    setMergeAllPending(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setMergeAllPending(false);
    }
  };

  // The split container the run-list column and drag handle live in — its width is the
  // clamp ceiling for the resize (the list can take at most half of it).
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    width: listWidth,
    minWidth: listMinWidth,
    maxWidth: listMaxWidth,
    onPointerDown: onResizePointerDown,
    onPointerMove: onResizePointerMove,
    onPointerUp: onResizePointerUp,
    onPointerCancel: onResizePointerCancel,
    onDoubleClick: onResizeDoubleClick,
    onKeyDown: onResizeKeyDown,
  } = useResizablePane(
    'dispatch:runs-list-width',
    DEFAULT_RUN_LIST_WIDTH,
    splitRef
  );

  // How many runs the archive filter is currently holding back — drives the toggle's
  // visibility and label. Computed independently of `data.visibleRuns` (which stops
  // excluding anything the moment `showArchived` is true, so its difference from
  // `data.runs` collapses to 0 right when the toggle is on): without this, the
  // control gating on "is anything hidden" would delete itself as soon as it's
  // switched on, leaving no way to switch it back off.
  const archivedTaskIds = useMemo(
    () => new Set(data.archivedTasks.map((t) => t.meta.id)),
    [data.archivedTasks]
  );
  const archivedRunCount =
    data.runs.length - hideArchivedRuns(data.runs, archivedTaskIds).length;

  const selected = data.runs.find((r) => r.id === selectedRunId);
  const selectedId = selected?.id;
  const selectedState = selected?.state;
  // The WS event only carries the id — this resolves the paths/reason RunLogView renders.
  const { request: pendingScopeRequest } = useScopeRequest(
    data.client,
    data.port,
    selectedId,
    selectedId !== undefined
      ? data.pendingScopeRequests.get(selectedId)?.requestId
      : undefined
  );

  // Built once per `data.tasksIncludingArchived`/`data.epics` change rather than re-scanned
  // per row: a run row's epic breadcrumb needs its task's `parent`, then that parent id's
  // title. Archived-inclusive (Task 9) so a run whose task has since been archived — visible
  // here once the shared "show archived" toggle is on — still resolves its breadcrumb/stack
  // instead of silently missing from the lookup.
  const taskById = useMemo(
    () => new Map(data.tasksIncludingArchived.map((t) => [t.meta.id, t])),
    [data.tasksIncludingArchived]
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
    // Terminal runs open on Session too. This used to jump to Diff whenever a
    // run had changes, which contradicted this view's own doc comment and meant
    // opening a run never showed you what the agent said — and reading the diff
    // now has a screen of its own in Review, so the transcript is the thing
    // this view is actually for.
    setTab('session');
    defaultedRunIdRef.current = selectedId;
  }, [selectedId, selectedState]);

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
      <div className="flex items-center gap-3">
        <h1 className="view-topbar-title">Runs</h1>
        <span className="dense-meta">
          {data.visibleRuns.length} shown
          {archivedRunCount > 0 && ` · ${archivedRunCount} archived`}
        </span>
        <div className="flex-1" />
        {showArchiveToggle(data.showArchived, archivedRunCount) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => data.setShowArchived(!data.showArchived)}
          >
            {data.showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={mergeReadyCount === 0 || mergeAllPending}
          onClick={() => void handleMergeAll()}
        >
          Merge all ready ({mergeReadyCount})
        </Button>
      </div>
      {data.lastPushError !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate">
            Merged locally — push failed: {data.lastPushError}
          </span>
          <Button
            variant="secondary"
            size="xs"
            disabled={mergeAllPending}
            onClick={() => void handleMergeAll()}
          >
            Retry
          </Button>
        </div>
      )}
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
          ) : data.visibleRuns.length === 0 ? (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <GitBranch className="size-5" />
              <p className="text-[13px]">
                No runs yet — dispatch a ready task from the Board to start one.
              </p>
            </div>
          ) : (
            data.visibleRuns.map((run) => {
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
                    'flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors duration-150',
                    run.id === selectedRunId
                      ? 'border-border bg-accent'
                      : 'hover:bg-muted/60'
                  )}
                >
                  {/* Two lines: the title gets the full width, and the state,
                      stack and cost sit under it. On one line the title was
                      competing with four other things and lost every time —
                      "Validate discount codes…" truncated to "Valid…". */}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[13px] leading-tight">
                      {run.taskTitle}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <RunStatePill meta={run} className="shrink-0" />
                      <RunKindBadge kind={run.kind} />
                      <MergeLadderDot
                        meta={data.latestRunByTaskId.get(run.taskId)}
                      />
                      <StackBadge
                        tasks={data.tasksIncludingArchived}
                        taskId={run.taskId}
                      />
                      {epicTitle !== undefined && (
                        <span className="text-muted-foreground min-w-0 truncate text-[11px]">
                          {epicTitle}
                        </span>
                      )}
                      <span className="flex-1" />
                      {run.costUsd !== undefined && (
                        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                          ${run.costUsd.toFixed(2)}
                        </span>
                      )}
                    </span>
                  </span>
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
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize run list"
          aria-valuenow={Math.round(listWidth)}
          aria-valuemin={Math.round(listMinWidth)}
          aria-valuemax={Math.round(listMaxWidth)}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerCancel}
          onDoubleClick={onResizeDoubleClick}
          onKeyDown={onResizeKeyDown}
          className="group focus-visible:ring-ring/50 relative w-2 shrink-0 cursor-col-resize touch-none outline-none focus-visible:ring-[3px]"
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
                trailing={
                  <div className="flex shrink-0 items-center gap-1">
                    <Segmented<RunTab>
                      label="Run tab"
                      value={tab}
                      onChange={setTab}
                      options={[
                        { value: 'session', label: 'Session' },
                        { value: 'diff', label: 'Diff' },
                      ]}
                    />
                    <IconToggle
                      on={detailsOpen}
                      onClick={() => setDetailsOpen((v) => !v)}
                      label={detailsOpen ? 'Hide details' : 'Show details'}
                    >
                      <PanelRight className="size-3.5" />
                    </IconToggle>
                    <IconToggle
                      on={selected.archivedAt !== undefined}
                      onClick={() =>
                        void data.handleArchiveRun(
                          selected.id,
                          selected.archivedAt === undefined
                        )
                      }
                      label={
                        selected.archivedAt === undefined
                          ? 'Archive this run'
                          : 'Unarchive this run'
                      }
                    >
                      <Archive className="size-3.5" />
                    </IconToggle>
                  </div>
                }
              />

              <StackRail
                tasks={data.tasksIncludingArchived}
                taskId={selected.taskId}
                latestRunByTaskId={data.latestRunByTaskId}
                onOpenTask={(taskId) => {
                  const run = data.latestRunByTaskId.get(taskId);
                  if (run !== undefined) onSelectRun(run.id);
                }}
              />

              {/* One content area, not a tab panel inside a tab list inside a
                  stack. Every ancestor from here down carries min-h-0 so the
                  transcript's own scroller gets a bounded height — without
                  that the log grows the page instead of scrolling, and
                  stick-to-bottom has nothing to stick to. */}
              <div className="flex min-h-0 flex-1 gap-4">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {tab === 'session' ? (
                    <RunLogView
                      meta={data.runDetail.meta}
                      entries={data.runDetail.entries}
                      pendingApproval={
                        data.pendingApprovals.get(selected.id) ?? null
                      }
                      onApprove={(requestId, allow, opts) =>
                        data.handleApprove(selected.id, requestId, allow, opts)
                      }
                      onSendMessage={(text) =>
                        data.handleSendMessage(selected.id, text)
                      }
                      openQuestions={
                        // Terminal check as well as the list: a dropped socket must not
                        // leave a dead run still asking for an answer.
                        isTerminalRunState(selected.state)
                          ? NO_QUESTIONS
                          : (data.openQuestions.get(selected.id) ??
                            NO_QUESTIONS)
                      }
                      onAnswerQuestion={(questionId, answer) =>
                        data.handleAnswerQuestion(
                          selected.id,
                          questionId,
                          answer
                        )
                      }
                      pendingScopeRequest={
                        isTerminalRunState(selected.state)
                          ? null
                          : pendingScopeRequest
                      }
                      onDecideScopeRequest={(granted) =>
                        data.handleDecideScopeRequest(
                          selected.id,
                          data.pendingScopeRequests.get(selected.id)
                            ?.requestId ?? '',
                          granted
                        )
                      }
                      onRequestChanges={(text) =>
                        data.handleRequestChanges(selected.id, text)
                      }
                    />
                  ) : !isTerminalRunState(selected.state) ? (
                    <RunDiffView
                      diff={data.diff}
                      diffLoading={data.diffLoading}
                      diffError={data.diffError}
                    />
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
                      tasks={data.tasksIncludingArchived}
                      latestRunByTaskId={data.latestRunByTaskId}
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
                      onQueueStack={() =>
                        data.handleEnqueueMergeStack(selected.taskId)
                      }
                      reviewComments={data.reviewComments}
                      onAddComment={data.handleAddReviewComment}
                      onResolveComment={data.handleResolveReviewComment}
                      onReplyComment={data.handleReplyReviewComment}
                      onSubmitReview={data.handleSubmitReview}
                    />
                  )}
                </div>

                {detailsOpen && (
                  <div className="min-h-0 w-64 shrink-0 overflow-y-auto">
                    <RunSidebar
                      meta={data.runDetail.meta}
                      diff={data.diff}
                      task={data.tasks.find(
                        (t) => t.meta.id === selected.taskId
                      )}
                      epicTitle={
                        data.epics.find(
                          (e) =>
                            e.meta.id ===
                            data.tasks.find(
                              (t) => t.meta.id === selected.taskId
                            )?.meta.parent
                        )?.meta.title ?? null
                      }
                      onOpenTask={(taskId) => {
                        const run = data.latestRunByTaskId.get(taskId);
                        if (run !== undefined) onSelectRun(run.id);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
