import type { EpicProgress, RunState } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

import { groupTasksByStatus } from '../../lib/boardGrouping';
import { statusTone } from '../../lib/taskDisplay';
import { Pill } from '../ui/Pill';
import { EpicCardTile } from './EpicCardTile';
import { TaskCardTile } from './TaskCardTile';
import './TaskBoard.css';

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
}

/** One column per tracker status, in the order the project's `.dispatch/config.yml` lists
 * them — never a hardcoded status list, so a custom tracker config reshapes the board
 * automatically (grouping itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByStatus`, rather than a per-status filter inlined here). No drag-and-drop:
 * status changes happen in the task peek panel — a ready task instead gets an inline
 * Dispatch action right on its card (see `TaskCardTile`), which is the actual "move it
 * forward" gesture this board wants to make easy. */
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
}: TaskBoardProps) {
  const columns = groupTasksByStatus(tasks, statuses);

  return (
    <div className="task-board">
      {columns.map(({ status, tasks: columnTasks }) => (
        <div className="task-board-column" key={status}>
          <div className="task-board-column-header">
            <Pill variant="status" tone={statusTone(status)}>
              {status}
            </Pill>
            <span className="task-board-column-count">
              {columnTasks.length}
            </span>
          </div>
          <div className="task-board-column-body">
            {columnTasks.length === 0 && (
              <div className="task-board-column-empty">No tasks</div>
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
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
