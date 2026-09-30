import { useEffect, useRef } from 'react';

import { TaskPage } from './page/TaskPage';
import { useTaskPageHost } from './page/TaskPageHost';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

/**
 * The task peek: the task page in its peek layout inside a centred 12px-radius dialog,
 * opened from a list without leaving it. Adds only what a peek needs beyond the page —
 * the dialog, Escape to close, and ⌘/Ctrl+Enter to grow into the full page.
 */
export function TaskPeekDialog({
  taskId,
  onClose,
  onExpand,
}: {
  taskId: string;
  onClose: () => void;
  onExpand: (taskId: string) => void;
}) {
  const host = useTaskPageHost();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onExpand(taskId);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onExpand, taskId]);
  if (host === null) return null;
  const title =
    host.project.tasksIncludingArchived.find((t) => t.meta.id === taskId)?.meta
      .title ?? 'Task';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] w-[min(1080px,94vw)] flex-col overflow-hidden sm:max-w-[1080px]"
        aria-describedby={undefined}
        showCloseButton={false}
        // Focus the popup itself: the default lands on the title field, and a browser
        // selects a focused text input's whole value, so the first key would wipe it.
        ref={contentRef}
        initialFocus={contentRef}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <TaskPage
          taskId={taskId}
          layout="peek"
          onClose={onClose}
          onExpand={() => onExpand(taskId)}
        />
      </DialogContent>
    </Dialog>
  );
}
