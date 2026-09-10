import type { PlannedTask } from '@dispatch/client';
import { useMemo } from 'react';

import { type TaskSpec, TaskSpecView } from '../tasks/TaskSpecView';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

/** Projects one still-unconfirmed plan task onto the shared spec shape. Blockers are keyed by
 * their proposal index (as a string), since drafts have no task ids yet. */
function specFromPlannedTask(
  task: PlannedTask,
  allTasks: PlannedTask[]
): TaskSpec {
  return {
    title: task.title,
    status: 'draft',
    priority: task.priority,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    writes: task.writes ?? [],
    risk: task.risk,
    blockedBy: task.blockedByIndices.flatMap((blockerIndex) => {
      const blocker = allTasks[blockerIndex];
      return blocker === undefined
        ? []
        : [{ key: String(blockerIndex), title: blocker.title }];
    }),
  };
}

export interface PlanTaskSpecDialogProps {
  /** Which proposal task is expanded, or null for closed. */
  index: number | null;
  tasks: PlannedTask[];
  /** Swaps the dialog to another proposal task — how blocker chips navigate. */
  onOpenIndex: (index: number) => void;
  onClose: () => void;
}

/**
 * A proposal task expanded to full detail — the same spec body the task page will render,
 * with the Draft status badge making clear nothing exists on the board yet. Blocker chips
 * swap the dialog to that task in place rather than stacking dialogs.
 */
export function PlanTaskSpecDialog({
  index,
  tasks,
  onOpenIndex,
  onClose,
}: PlanTaskSpecDialogProps) {
  const task = index !== null ? tasks[index] : undefined;
  const spec = useMemo(
    () => (task === undefined ? null : specFromPlannedTask(task, tasks)),
    [task, tasks]
  );

  return (
    <Dialog
      open={spec !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Zero padding: the spec view carries RecommendationCard's own edge-to-edge section
          layout, so the dialog is just the frame. The first-child pad keeps the title clear
          of the dialog's absolute close button. */}
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {spec !== null && (
          <>
            {/* The spec body renders its own visible title; this satisfies the dialog's
                accessible-name requirement without doubling it on screen. */}
            <DialogTitle className="sr-only">{spec.title}</DialogTitle>
            <TaskSpecView
              spec={spec}
              onOpenBlocker={(key) => onOpenIndex(Number(key))}
              className="[&>*:first-child]:pr-10"
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
