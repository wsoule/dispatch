import type { EpicProgress, RunState } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

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
  /** Live (non-terminal) run state per task id — see TasksPanel's `liveRunStateByTaskId`. */
  liveRunStateByTaskId: Map<string, RunState>;
  /** Epic dispatch progress per epic id, once fetched — see TasksPanel's `epicProgressById`. */
  epicProgressById: Map<string, EpicProgress>;
  /** Default concurrency for a fresh epic dispatch session (config's `orchestrator.epicConcurrency`). */
  epicConcurrencyDefault: number;
  onSelect: (id: string) => void;
  onWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  onStopEpic: (epicId: string) => Promise<void>;
}

/** One column per tracker status, in the order the project's `.dispatch/config.yml` lists
 * them — never a hardcoded status list, so a custom tracker config reshapes the board
 * automatically. No drag-and-drop: status changes happen in `TaskDetailModal` (matches
 * packages/web/src/components/Board.tsx's own YAGNI call for this phase). */
export function TaskBoard({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  epicProgressById,
  epicConcurrencyDefault,
  onSelect,
  onWorkEpic,
  onStopEpic,
}: TaskBoardProps) {
  return (
    <div className="task-board">
      {statuses.map((status) => {
        const columnTasks = tasks.filter((t) => t.meta.status === status);
        return (
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
                  />
                ) : (
                  <TaskCardTile
                    key={doc.meta.id}
                    doc={doc}
                    ready={readyIds.has(doc.meta.id)}
                    blocked={blockedIds.has(doc.meta.id)}
                    liveRunState={liveRunStateByTaskId.get(doc.meta.id)}
                    onClick={() => onSelect(doc.meta.id)}
                  />
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
