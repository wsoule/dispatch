import type { EpicProgress, RunState } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

import { groupTasksByStatus } from '../../lib/boardGrouping';
import { statusTone } from '../../lib/taskDisplay';
import { EpicCardTile } from './EpicCardTile';
import { TaskCardTile } from './TaskCardTile';
import { cn } from '@/lib/utils';

interface TaskBoardProps {
  tasks: TaskDoc[];
  statuses: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  /** Live (non-terminal) run state per task id. */
  liveRunStateByTaskId: Map<string, RunState>;
  /** Epic dispatch progress per epic id, once fetched. */
  epicProgressById: Map<string, EpicProgress>;
  /** Default concurrency for a fresh epic dispatch session (config's `orchestrator.epicConcurrency`). */
  epicConcurrencyDefault: number;
  onSelect: (id: string) => void;
  /** Dispatches a plain (non-epic) task directly from its card's inline ready-lane button.
   * Optional — omitting it (rather than requiring every caller to wire it up) simply hides
   * the inline action and leaves dispatching to the task detail view, the same as before this
   * card gained a ready-lane shortcut. */
  onDispatch?: (taskId: string) => Promise<void>;
  onWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  onStopEpic: (epicId: string) => Promise<void>;
  /** Id of the card the Board's j/k roving-focus cursor is currently on, if any — see
   * `BoardView`'s column-major traversal. `undefined`/no match renders every card unfocused. */
  focusedTaskId?: string | null;
  /** Called whenever real DOM focus lands on any card (click, Tab, or the roving-focus
   * effect) — lets `BoardView` sync `focusedTaskId` to wherever focus actually is, so a
   * mouse click (which the j/k cursor never hears about on its own) can't leave Enter
   * opening a stale card instead of the one that's visibly focused. */
  onCardFocus?: (taskId: string) => void;
}

/** One dot color per `statusTone` — the column header's status indicator (a small colored
 * dot, not a text pill, per the redesign brief) rather than the old `Pill`. */
const STATUS_DOT_CLASS: Record<string, string> = {
  green: 'bg-emerald-500 dark:bg-emerald-400',
  blue: 'bg-blue-500 dark:bg-blue-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-red-500 dark:bg-red-400',
  gray: 'bg-muted-foreground/50',
  accent: 'bg-primary',
};

/** One column per tracker status, in the order the project's `.dispatch/config.yml` lists
 * them — never a hardcoded status list, so a custom tracker config reshapes the board
 * automatically (grouping itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByStatus`, rather than a per-status filter inlined here). No drag-and-drop:
 * status changes happen in the task peek panel — a ready task instead gets an inline
 * Dispatch action right on its card (see `TaskCardTile`), which is the actual "move it
 * forward" gesture this board wants to make easy.
 *
 * Columns render as open lanes sitting directly on the page background (a header row, then a
 * card stack) rather than bordered/backgrounded boxes — the redesign brief's "OPEN lanes, NOT
 * bordered boxes" direction. */
export function TaskBoard({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  epicProgressById,
  epicConcurrencyDefault,
  onSelect,
  onDispatch,
  onWorkEpic,
  onStopEpic,
  focusedTaskId = null,
  onCardFocus,
}: TaskBoardProps) {
  const columns = groupTasksByStatus(tasks, statuses);

  return (
    <div className="flex h-full min-h-0 gap-6 overflow-x-auto pb-2">
      {columns.map(({ status, tasks: columnTasks }) => (
        <div key={status} className="flex w-[272px] shrink-0 flex-col gap-2">
          <div className="flex items-center gap-2 px-0.5">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                STATUS_DOT_CLASS[statusTone(status)]
              )}
            />
            <span className="text-muted-foreground truncate text-[11px] font-medium">
              {status}
            </span>
            <span className="text-muted-foreground/60 font-mono text-[11px]">
              {columnTasks.length}
            </span>
          </div>
          <div className="flex min-h-10 flex-col gap-2 overflow-y-auto">
            {columnTasks.length === 0 && (
              <div className="text-muted-foreground/50 px-0.5 py-1 text-[11px]">
                No tasks
              </div>
            )}
            {columnTasks.map((doc) =>
              doc.meta.kind === 'epic' ? (
                <EpicCardTile
                  key={doc.meta.id}
                  doc={doc}
                  progress={epicProgressById.get(doc.meta.id)}
                  concurrencyDefault={epicConcurrencyDefault}
                  onSelect={() => onSelect(doc.meta.id)}
                  onWork={onWorkEpic}
                  onStop={onStopEpic}
                  focused={doc.meta.id === focusedTaskId}
                  onFocus={() => onCardFocus?.(doc.meta.id)}
                />
              ) : (
                <TaskCardTile
                  key={doc.meta.id}
                  doc={doc}
                  ready={readyIds.has(doc.meta.id)}
                  blocked={blockedIds.has(doc.meta.id)}
                  liveRunState={liveRunStateByTaskId.get(doc.meta.id)}
                  onClick={() => onSelect(doc.meta.id)}
                  onDispatch={
                    readyIds.has(doc.meta.id) && onDispatch !== undefined
                      ? () => onDispatch(doc.meta.id)
                      : undefined
                  }
                  focused={doc.meta.id === focusedTaskId}
                  onFocus={() => onCardFocus?.(doc.meta.id)}
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
