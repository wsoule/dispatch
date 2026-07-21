import { LayoutGrid, Plus, Rows3, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { TaskBoard } from '../components/tasks/TaskBoard';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import { groupTasksByStatus } from '../lib/boardGrouping';
import { resolveListKeyCommand } from '../lib/keyboard';
import { TasksListView } from './TasksListView';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

interface BoardViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  /** Opens `CreateTaskModal`, optionally pre-set to a given status — the column/group
   * header's hover "+" button passes its own status through; the header's plain "New task"
   * button omits it and lets the modal default to the first configured status. */
  onNewTask: (status?: string) => void;
  onPlanWork: () => void;
}

type TasksViewMode = 'board' | 'list';

// Persists the List/Board choice across restarts — Linear's own display toggle remembers
// itself the same way. Guarded for `window` even though this is a Tauri/browser-only app
// (never SSR'd) so a stray server-side render of this module (e.g. a future test harness)
// can't throw on a missing `localStorage`.
const VIEW_MODE_STORAGE_KEY = 'dispatch:tasks-view-mode';

function readStoredViewMode(): TasksViewMode {
  if (typeof window === 'undefined') return 'board';
  return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'list'
    ? 'list'
    : 'board';
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
 * The heart of the app: the project's tasks as either a Linear-density Kanban (one column per
 * configured tracker status, drag-and-drop to change status) or a dense grouped list — a
 * segmented List/Board toggle in the header switches between them and remembers the choice
 * (localStorage), defaulting to Board. This is the single "Tasks" nav destination (the
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
  const [mode, setMode] = useState<TasksViewMode>(readStoredViewMode);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }, [mode]);

  // Hooks run unconditionally on every render (before any of the early returns below) — both
  // are cheap no-ops (empty array in, empty array out) while the daemon/board data isn't
  // ready yet.
  const columns = useMemo(
    () =>
      data.config !== null
        ? groupTasksByStatus(data.tasks, data.config.statuses)
        : [],
    [data.tasks, data.config]
  );
  const orderedTaskIds = useMemo(
    () => columns.flatMap((column) => column.tasks.map((t) => t.meta.id)),
    [columns]
  );

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
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-[13px] font-semibold">Tasks</h1>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="View"
            className="border-border flex items-center rounded-md border p-0.5"
          >
            <button
              type="button"
              title="List view"
              aria-pressed={mode === 'list'}
              onClick={() => setMode('list')}
              className={cn(
                'rounded-[5px] p-1 transition-colors duration-150',
                mode === 'list'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Rows3 className="size-3.5" />
            </button>
            <button
              type="button"
              title="Board view"
              aria-pressed={mode === 'board'}
              onClick={() => setMode('board')}
              className={cn(
                'rounded-[5px] p-1 transition-colors duration-150',
                mode === 'board'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <LayoutGrid className="size-3.5" />
            </button>
          </div>
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

      {data.tasks.length === 0 ? (
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
            tasks={data.tasks}
            statuses={data.config.statuses}
            readyIds={data.readyIds}
            blockedIds={data.blockedIds}
            liveRunStateByTaskId={data.liveRunStateByTaskId}
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
        <TasksListView
          data={data}
          onSelectTask={onSelectTask}
          onAddTask={onNewTask}
        />
      )}
    </div>
  );
}
