import type { TaskDoc } from '@dispatch/core/browser';

import { EpicDagView } from './EpicDagView';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';

export interface EpicDagModalProps {
  /** The epic whose graph is open, or `null` when the modal is closed — a view-local-state
   * discriminated-by-value prop (mirroring `DiffModal`'s `filePath: string | null`) rather
   * than a separate boolean, so each of this feature's three entry points (TasksListView's
   * group header, EpicCardTile, TaskDetailPanel) can own one small piece of state instead of
   * this needing to be threaded through App-level nav state. */
  epic: TaskDoc | null;
  /** The epic's children — already filtered by the caller (each entry point already has the
   * full project task list in scope), so this modal never recomputes it itself. */
  tasks: TaskDoc[];
  onOpenTask?: (taskId: string) => void;
  onClose: () => void;
}

/**
 * Wraps `EpicDagView` in the repo's standard shadcn `Dialog` (see `DiffModal`/
 * `SessionDetailModal` for the same pattern) so the three call sites that open the DAG view
 * don't each duplicate this boilerplate. Deliberately thin — all the actual graph logic lives
 * in `EpicDagView`/`dagLayout`.
 */
export function EpicDagModal({
  epic,
  tasks,
  onOpenTask,
  onClose,
}: EpicDagModalProps) {
  return (
    <Dialog
      open={epic !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <span className="text-muted-foreground font-mono text-[11px]">
              {epic?.meta.id}
            </span>
            {epic?.meta.title ?? 'Dependency graph'}
          </DialogTitle>
        </DialogHeader>
        {epic !== null && <EpicDagView tasks={tasks} onOpenTask={onOpenTask} />}
      </DialogContent>
    </Dialog>
  );
}
