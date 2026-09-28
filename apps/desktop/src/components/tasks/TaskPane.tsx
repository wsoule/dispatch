import { TaskPage } from './page/TaskPage';

interface TaskPaneProps {
  taskId: string;
  onClose: () => void;
  /** Grows the pane into the full task page. */
  onExpand: () => void;
}

/**
 * One task beside a list — the Cockpit's split view. Callers only ever say which task;
 * the state-adaptive task page draws it in its split layout, from the host App provides
 * (see TaskPageHostContext).
 */
export function TaskPane({ taskId, onClose, onExpand }: TaskPaneProps) {
  return (
    <section
      aria-label="Task"
      data-slot="task-pane"
      data-task-id={taskId}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <TaskPage
        taskId={taskId}
        layout="split"
        onClose={onClose}
        onExpand={onExpand}
      />
    </section>
  );
}
