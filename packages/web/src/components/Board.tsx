import type { TaskDoc } from '@dispatch/core';

import { TaskCard } from './TaskCard';

export interface BoardProps {
  tasks: TaskDoc[];
  statuses: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  onSelect: (id: string) => void;
}

// One column per tracker status, in the order `.dispatch/config.yml` lists
// them — never a hardcoded six-status list, so a custom tracker config
// reshapes the board automatically. No drag-and-drop: status changes happen
// in the detail drawer (YAGNI for this phase, per the plan).
export function Board({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  onSelect,
}: BoardProps) {
  return (
    <div className="board">
      {statuses.map((status) => {
        const columnTasks = tasks.filter((t) => t.meta.status === status);
        return (
          <div className="board__column" key={status}>
            <div className="board__column-header">
              <span className="status-pill" data-status={status}>
                {status}
              </span>
              <span className="board__column-count">{columnTasks.length}</span>
            </div>
            <div className="board__column-body">
              {columnTasks.length === 0 && (
                <div className="board__empty">No tasks</div>
              )}
              {columnTasks.map((doc) => (
                <TaskCard
                  key={doc.meta.id}
                  doc={doc}
                  ready={readyIds.has(doc.meta.id)}
                  blocked={blockedIds.has(doc.meta.id)}
                  onClick={() => onSelect(doc.meta.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
