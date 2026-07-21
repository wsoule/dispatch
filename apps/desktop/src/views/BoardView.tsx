import { TaskBoard } from '../components/tasks/TaskBoard';
import { Button } from '../components/ui/Button';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import './BoardView.css';

interface BoardViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onPlanWork: () => void;
}

/**
 * The heart of the app: a Linear-density Kanban of the active project's tasks, one column
 * per configured tracker status. Ready-to-start cards carry the accent treatment and an
 * inline Dispatch button (see `TaskCardTile`) so moving work forward never requires opening
 * the peek panel first. Loading/error/empty states mirror the old `TasksPanel`'s (starting
 * the daemon, daemon failed to start, no tasks yet) since this view now owns exactly the
 * slice of that component's responsibilities that belonged to the board.
 */
export function BoardView({
  data,
  onSelectTask,
  onNewTask,
  onPlanWork,
}: BoardViewProps) {
  if (data.portLoading) {
    return <p className="board-view-status">Starting the task daemon…</p>;
  }

  if (data.portError || data.client === null) {
    return (
      <div className="board-view-status">
        <p>
          Couldn&rsquo;t start dispatchd for this project
          {data.portErrorDetail instanceof Error
            ? `: ${data.portErrorDetail.message}`
            : '.'}
        </p>
        <Button variant="secondary" onClick={data.retryEnsureDispatchd}>
          Retry
        </Button>
      </div>
    );
  }

  if (data.tasksLoading || data.config === null) {
    return <p className="board-view-status">Loading board…</p>;
  }

  return (
    <div className="board-view">
      <div className="board-view-toolbar">
        <h1 className="view-topbar-title">Board</h1>
        <div className="board-view-toolbar-actions">
          <Button variant="secondary" onClick={onPlanWork}>
            Plan work…
          </Button>
          <Button onClick={onNewTask}>+ New Task</Button>
        </div>
      </div>

      {data.tasks.length === 0 ? (
        <p className="board-view-status">
          No tasks yet — create the first one, or describe the work with
          &ldquo;Plan work…&rdquo; and let the planner draft it.
        </p>
      ) : (
        <TaskBoard
          tasks={data.tasks}
          statuses={data.config.statuses}
          readyIds={data.readyIds}
          blockedIds={data.blockedIds}
          liveRunStateByTaskId={data.liveRunStateByTaskId}
          epicProgressById={data.epicProgressById}
          epicConcurrencyDefault={data.config.orchestrator.epicConcurrency}
          onSelect={onSelectTask}
          onDispatch={data.handleDispatch}
          onWorkEpic={data.handleWorkEpic}
          onStopEpic={data.handleStopEpic}
        />
      )}
    </div>
  );
}
