import {
  Archive,
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
import { groupTasksByEpicLane, visibleLaneTaskIds } from '../lib/boardGrouping';
import {
  COLLAPSED_EPICS_STORAGE_KEY,
  parseCollapsedEpics,
  serializeCollapsedEpics,
  toggleCollapsedEpic,
} from '../lib/collapsedEpics';
import { resolveListKeyCommand } from '../lib/keyboard';
import { countMergeReady } from '../lib/mergeReady';
import type { TasksViewMode } from '../lib/tasksViewMode';
import { parseViewMode, VIEW_MODE_STORAGE_KEY } from '../lib/tasksViewMode';
import { MilestonesView } from './MilestonesView';
import { TasksListView } from './TasksListView';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { Toggle } from '@/ui/toggle';

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
 * toggle in the header and remembered across restarts. `board` is the default — the unified
 * kanban, where every epic is an expandable header over the project's configured status columns.
 * There is no separate swim-lanes mode any more: the flat board and the lanes were the same board
 * grouped two ways, and collapsing every epic gets you back to a compact overview without a
 * second layout to choose between. `list` is the dense grouped list and `milestones` groups by
 * milestone. This is the single "Tasks" nav destination (the redesign brief's option (b): Board
 * and the old flat Tasks list are no longer two separate nav items, since Linear itself doesn't
 * split them — they're one destination with a display toggle). Loading/error/empty states mirror
 * the old `TasksPanel`'s (starting the daemon, daemon failed to start, no tasks yet).
 *
 * j/k/Enter roving focus (I6): the Board's own traversal runs lane by lane and column-major
 * inside a lane (down a status column, then across), over the cards that are actually on screen —
 * a collapsed epic's cards are skipped entirely. See `handleBoardKeyDown` below; the List's is
 * row-major across its grouped rows (see `TasksListView`). Both live independently since only one
 * is ever mounted at a time.
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
  // Which epic lanes are folded up. Session-scoped (see `collapsedEpics.ts`) and lifted to the
  // view rather than kept inside `TaskBoard` because the j/k cursor below has to skip the cards a
  // collapsed lane is hiding.
  const [collapsedLaneKeys, setCollapsedLaneKeys] = useState<
    ReadonlySet<string>
  >(() =>
    parseCollapsedEpics(
      typeof window === 'undefined'
        ? null
        : window.sessionStorage.getItem(COLLAPSED_EPICS_STORAGE_KEY)
    )
  );
  // Which epic's dispatch is awaiting confirmation, or null when the dialog is closed.
  const [dispatchEpicId, setDispatchEpicId] = useState<string | null>(null);
  // "Merge all ready" toolbar button state — see the merge queue's identical control
  // for the fuller comment; this is the Board's copy of the same action.
  const [mergeAllPending, setMergeAllPending] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    window.sessionStorage.setItem(
      COLLAPSED_EPICS_STORAGE_KEY,
      serializeCollapsedEpics(collapsedLaneKeys)
    );
  }, [collapsedLaneKeys]);

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
  // The same lanes `TaskBoard` renders, from the same pure function — this copy exists only to
  // give the j/k cursor an order that matches what is on screen.
  const lanes = useMemo(
    () =>
      data.config !== null
        ? groupTasksByEpicLane(boardTasks, data.config.statuses, data.epics)
        : [],
    [boardTasks, data.config, data.epics]
  );
  const orderedTaskIds = useMemo(
    () => visibleLaneTaskIds(lanes, collapsedLaneKeys),
    [lanes, collapsedLaneKeys]
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
    // A keydown that lands on (or inside) one of the track's own interactive controls — an epic
    // lane header's toggle or Work/Stop button, its concurrency `<input>`, or a card's inline
    // "Dispatch" button. `.closest()` catches the case where the control wraps an inner element.
    // Task cards are role="button" divs (not real <button>s), so they fall through to the
    // roving-cursor logic as intended.
    const controlEl = (e.target as HTMLElement).closest(
      'button, a, select, input, textarea, [contenteditable="true"]'
    );
    const onControl = controlEl !== null && controlEl !== e.currentTarget;
    // Computed from the real event target, not hardcoded — belt-and-braces with the typing
    // check `resolveListKeyCommand` does for text fields specifically.
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: isTypingTarget(e.target) }
    );
    if (command === null || orderedTaskIds.length === 0) return;
    // Enter/Space belong to whatever control has focus — activating it, not opening the card the
    // cursor happens to be on. j/k are nobody's activation key, so they keep steering the board
    // from a control too: clicking an epic header to expand it leaves focus on that header, and
    // navigation going dead right afterwards is exactly when it feels broken.
    if (command === 'list-confirm') {
      if (onControl) return;
      e.preventDefault();
      if (focusedTaskId !== null) onSelectTask(focusedTaskId);
      return;
    }
    e.preventDefault();
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
          <Tabs value={mode} onValueChange={(v) => setMode(v as TasksViewMode)}>
            <TabsList
              aria-label="View"
              className="border-border h-7 gap-0.5 rounded-md border bg-transparent p-0.5"
            >
              <TabsTrigger
                value="list"
                className="px-2 text-[13px] font-normal"
              >
                <Rows3 className="size-3.5" />
                <span className="whitespace-nowrap max-sm:sr-only">
                  List view
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="board"
                className="px-2 text-[13px] font-normal"
              >
                <LayoutGrid className="size-3.5" />
                <span className="whitespace-nowrap max-sm:sr-only">
                  Board view
                </span>
              </TabsTrigger>
              {/* Milestones groups the same tasks a different way — it belongs
                  beside the other groupings, not in the rail as its own place. */}
              <TabsTrigger
                value="milestones"
                className="px-2 text-[13px] font-normal"
              >
                <Target className="size-3.5" />
                <span className="whitespace-nowrap max-sm:sr-only">
                  Milestones
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {showArchiveToggle(data.showArchived, data.archivedTasks.length) && (
            <Toggle
              variant="outline"
              size="sm"
              pressed={data.showArchived}
              onPressedChange={data.setShowArchived}
              className="data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground data-[state=on]:hover:bg-secondary/80 gap-1.5 px-3 has-[>svg]:px-2.5"
            >
              <Archive className="size-3.5" />
              Archived ({data.archivedTasks.length})
            </Toggle>
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
        <EmptyState
          icon={LayoutGrid}
          message="No tasks yet. Create one, or let “Plan work…” draft them."
          className="flex-1 justify-center gap-3 p-0 text-[13px] [&_[data-slot=empty-description]]:max-w-sm [&_[data-slot=empty-description]]:text-[length:inherit]"
          action={
            <Button size="sm" onClick={() => onNewTask()}>
              <Plus className="size-3.5" />
              New task
            </Button>
          }
        />
      ) : mode === 'milestones' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MilestonesView data={data} onOpenTask={onSelectTask} />
        </div>
      ) : mode === 'board' ? (
        // `tabIndex={0}` puts the track itself in the natural tab order (so someone can
        // Tab/click into the board and start using j/k immediately) — the individual cards
        // remain the real roving-focus targets once `focusedTaskId` moves onto one of them.
        <div
          className="min-h-0 flex-1"
          tabIndex={0}
          onKeyDown={handleBoardKeyDown}
        >
          <TaskBoard
            collapsedLaneKeys={collapsedLaneKeys}
            onToggleLane={(key) =>
              setCollapsedLaneKeys((prev) => toggleCollapsedEpic(prev, key))
            }
            onRequestWorkEpic={setDispatchEpicId}
            tasks={boardTasks}
            archivedTaskIds={archivedTaskIds}
            statuses={data.config.statuses}
            readyIds={data.readyIds}
            blockedIds={data.blockedIds}
            liveRunStateByTaskId={data.liveRunStateByTaskId}
            latestRunByTaskId={data.latestRunByTaskId}
            attentionByTaskId={data.attentionByTaskId}
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
