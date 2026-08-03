import {
  Archive,
  Layers,
  LayoutGrid,
  Plus,
  Rows3,
  Sparkles,
  Target,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { TaskBoard } from '../components/tasks/TaskBoard';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import { showArchiveToggle } from '../lib/archiveToggle';
import { groupTasksByStatus } from '../lib/boardGrouping';
import { resolveListKeyCommand } from '../lib/keyboard';
import { countMergeReady } from '../lib/mergeReady';
import type { TasksViewMode } from '../lib/tasksViewMode';
import { parseViewMode, VIEW_MODE_STORAGE_KEY } from '../lib/tasksViewMode';
import { MilestonesView } from './MilestonesView';
import { TasksListView } from './TasksListView';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/chrome/Segmented';
import { Skeleton } from '@/ui/skeleton';

interface BoardViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  /** Opens `CreateTaskModal`, optionally pre-set to a given status — TaskBoard's column
   * header's hover "+" button passes its own status through; other contexts omit it and let
   * the modal default to the first configured status. */
  onNewTask: (status?: string) => void;
  onPlanWork: () => void;
}

/** Skeleton placeholder for the board while tasks/config are loading — one column's worth of
 * shapes (a dot + label header, then a few card-sized blocks) repeated a few times, standing
 * in for the "Loading board…" text the redesign brief asks every loading state to drop. */
function BoardSkeleton() {
  return (
    <div className="flex h-full min-h-0 gap-6 overflow-hidden pb-2">
      {Array.from({ length: 4 }, (_, columnIndex) => (
        <div
          key={columnIndex}
          className="flex w-[272px] shrink-0 flex-col gap-2"
        >
          <div className="flex items-center gap-2 px-0.5">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, cardIndex) => (
              <Skeleton
                key={cardIndex}
                className="h-[86px] w-full rounded-[10px]"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The heart of the app: the project's tasks in one of three layouts, switched by a segmented
 * toggle in the header and remembered across restarts. `lanes` is the default — one swim lane
 * per epic, with the project's configured status columns repeated inside each, which reads as a
 * grid of epics against statuses and answers "which epic is stuck". `board` is the flat
 * single-set-of-columns Kanban, and `list` the dense grouped list. All three keep the
 * drag-and-drop and the configured statuses. This is the single "Tasks" nav destination (the
 * redesign brief's option (b): Board and the old flat Tasks list are no longer two separate
 * nav items, since Linear itself doesn't split them — they're one destination with a display
 * toggle). Loading/error/empty states mirror the old `TasksPanel`'s (starting the daemon,
 * daemon failed to start, no tasks yet).
 *
 * j/k/Enter roving focus (I6): the Board's own traversal is *column-major* (down through a
 * column's cards top to bottom, then wrap to the next column) — see `handleBoardKeyDown`
 * below; the List's is row-major across its grouped rows (see `TasksListView`). Both live
 * independently since only one is ever mounted at a time.
 */
export function BoardView({
  data,
  onSelectTask,
  onNewTask,
  onPlanWork,
}: BoardViewProps) {
  const [mode, setMode] = useState<TasksViewMode>(() =>
    parseViewMode(
      typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    )
  );
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  // Which epic's dispatch is awaiting confirmation, or null when the dialog is closed.
  const [dispatchEpicId, setDispatchEpicId] = useState<string | null>(null);
  // "Merge all ready" toolbar button state — see RunsView's identical control
  // for the fuller comment; this is the Board's copy of the same action.
  const [mergeAllPending, setMergeAllPending] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }, [mode]);

  // Hooks run unconditionally on every render (before any of the early returns below) — both
  // are cheap no-ops (empty array in, empty array out) while the daemon/board data isn't
  // ready yet.
  // Task 9: with the "Archived" toggle on, archived tasks join the board so their (typically
  // Done) column shows them dimmed rather than just silently vanishing — `data.tasks` stays
  // untouched so every other consumer here (orderedTaskIds, the empty-state check below)
  // keeps its original archived-excluded meaning.
  const boardTasks = useMemo(
    () =>
      data.showArchived ? [...data.tasks, ...data.archivedTasks] : data.tasks,
    [data.tasks, data.archivedTasks, data.showArchived]
  );
  const archivedTaskIds = useMemo(
    () => new Set(data.archivedTasks.map((t) => t.meta.id)),
    [data.archivedTasks]
  );
  const columns = useMemo(
    () =>
      data.config !== null
        ? groupTasksByStatus(boardTasks, data.config.statuses)
        : [],
    [boardTasks, data.config]
  );
  const orderedTaskIds = useMemo(
    () => columns.flatMap((column) => column.tasks.map((t) => t.meta.id)),
    [columns]
  );
  const queuedRunIds = useMemo(
    () => new Set((data.mergeQueue?.entries ?? []).map((e) => e.runId)),
    [data.mergeQueue]
  );
  const mergeReadyCount = useMemo(
    () => countMergeReady(data.runs, data.tasksIncludingArchived, queuedRunIds),
    [data.runs, data.tasksIncludingArchived, queuedRunIds]
  );
  const handleMergeAll = async () => {
    setMergeAllPending(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setMergeAllPending(false);
    }
  };

  function handleBoardKeyDown(e: React.KeyboardEvent) {
    // A keydown that lands on (or inside) one of the track's own interactive controls —
    // an epic card's Work/Stop button, its concurrency `<input>`, or a card's inline
    // "Dispatch" button — belongs to that control, not to board navigation. `.closest()`
    // catches the case where the control wraps an inner element. Task cards are role="button"
    // divs (not real <button>s), so they fall through to the roving-cursor logic as intended.
    const controlEl = (e.target as HTMLElement).closest(
      'button, a, select, input, textarea, [contenteditable="true"]'
    );
    if (controlEl !== null && controlEl !== e.currentTarget) return;
    // Computed from the real event target, not hardcoded — belt-and-braces with the guard
    // above for typing targets specifically.
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: isTypingTarget(e.target) }
    );
    if (command === null || orderedTaskIds.length === 0) return;
    e.preventDefault();
    if (command === 'list-confirm') {
      if (focusedTaskId !== null) onSelectTask(focusedTaskId);
      return;
    }
    const currentIndex =
      focusedTaskId !== null ? orderedTaskIds.indexOf(focusedTaskId) : -1;
    const nextIndex =
      command === 'list-down'
        ? Math.min(currentIndex + 1, orderedTaskIds.length - 1)
        : Math.max(currentIndex - 1, 0);
    setFocusedTaskId(orderedTaskIds[Math.max(nextIndex, 0)] ?? null);
  }

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  if (data.tasksLoading || data.config === null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        <h1 className="text-foreground text-[13px] font-semibold">Tasks</h1>
        <BoardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-foreground text-[13px] leading-6 font-semibold">
          Tasks
        </h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Segmented<TasksViewMode>
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'list',
                label: 'List view',
                icon: <Rows3 className="size-3.5" />,
              },
              {
                value: 'board',
                label: 'Board view',
                icon: <LayoutGrid className="size-3.5" />,
              },
              {
                value: 'lanes',
                label: 'Epic swim lanes',
                icon: <Layers className="size-3.5" />,
              },
              // Milestones groups the same tasks a different way — it belongs
              // beside the other groupings, not in the rail as its own place.
              {
                value: 'milestones',
                label: 'Milestones',
                icon: <Target className="size-3.5" />,
              },
            ]}
          />
          {showArchiveToggle(data.showArchived, data.archivedTasks.length) && (
            <Button
              variant={data.showArchived ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={data.showArchived}
              onClick={() => data.setShowArchived(!data.showArchived)}
            >
              <Archive className="size-3.5" />
              Archived ({data.archivedTasks.length})
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
          <Button variant="secondary" size="sm" onClick={onPlanWork}>
            <Sparkles className="size-3.5" />
            Plan work…
          </Button>
          <Button size="sm" onClick={() => onNewTask()}>
            <Plus className="size-3.5" />
            New task
          </Button>
        </div>
      </div>

      {boardTasks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <LayoutGrid className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            No tasks yet — create the first one, or describe the work with
            &ldquo;Plan work…&rdquo; and let the planner draft it.
          </p>
          <Button size="sm" onClick={() => onNewTask()}>
            <Plus className="size-3.5" />
            New task
          </Button>
        </div>
      ) : mode === 'milestones' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MilestonesView data={data} onOpenTask={onSelectTask} />
        </div>
      ) : mode === 'board' || mode === 'lanes' ? (
        // `tabIndex={0}` puts the track itself in the natural tab order (so someone can
        // Tab/click into the board and start using j/k immediately) — the individual cards
        // remain the real roving-focus targets once `focusedTaskId` moves onto one of them.
        <div
          className="min-h-0 flex-1"
          tabIndex={0}
          onKeyDown={handleBoardKeyDown}
        >
          <TaskBoard
            swimLanes={mode === 'lanes'}
            onRequestWorkEpic={setDispatchEpicId}
            tasks={boardTasks}
            archivedTaskIds={archivedTaskIds}
            statuses={data.config.statuses}
            readyIds={data.readyIds}
            blockedIds={data.blockedIds}
            liveRunStateByTaskId={data.liveRunStateByTaskId}
            latestRunByTaskId={data.latestRunByTaskId}
            epicProgressById={data.epicProgressById}
            epicConcurrencyDefault={data.config.orchestrator.epicConcurrency}
            epics={data.epics}
            onSelect={onSelectTask}
            onDispatch={data.handleDispatch}
            onWorkEpic={data.handleWorkEpic}
            onStopEpic={data.handleStopEpic}
            onMoveStatus={data.moveTaskStatus}
            onEditTask={data.handleUpdate}
            onAddTask={onNewTask}
            focusedTaskId={focusedTaskId}
            onCardFocus={setFocusedTaskId}
          />
        </div>
      ) : (
        <TasksListView data={data} onSelectTask={onSelectTask} />
      )}

      {dispatchEpicId !== null && (
        <DispatchDialog
          title="Send agents at this epic"
          tasks={data.tasks.filter((t) => t.meta.parent === dispatchEpicId)}
          readyIds={data.readyIds}
          runningNow={data.liveRunStateByTaskId.size}
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
          onCancel={() => setDispatchEpicId(null)}
          onConfirm={async (concurrency) => {
            await data.handleWorkEpic(dispatchEpicId, concurrency);
            setDispatchEpicId(null);
          }}
        />
      )}
    </div>
  );
}
