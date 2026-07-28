import type { TaskDoc } from '@dispatch/core';
import { Target, TriangleAlert } from 'lucide-react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import { StatusIcon } from '../components/tasks/StatusIcon';
import { StateDot } from '../components/ui/StateDot';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  deriveMilestoneStatus,
  MILESTONE_HEALTH_LABEL,
} from '../lib/milestoneRisk';
import { cn } from '@/lib/utils';

interface MilestonesViewProps {
  data: DispatchProjectData;
  onOpenTask: (taskId: string) => void;
}

interface MilestoneGroup {
  name: string;
  tasks: TaskDoc[];
  done: number;
}

// A task counts as "done" for milestone progress when its status is a terminal one — the two
// built-in closed statuses. (A custom tracker could name these differently, but done/cancelled
// cover every default project and degrade gracefully otherwise.)
function isClosed(task: TaskDoc): boolean {
  return task.meta.status === 'done' || task.meta.status === 'cancelled';
}

/**
 * Top-level Milestones view — the Linear-style grouping *above* epics/tasks (product vision:
 * "projects or milestones like Linear"). Groups every task with a milestone name into a card
 * showing its progress (closed/total + a bar) and its tasks; unassigned tasks are left out so
 * a milestone reads as a deliberate slice of work. Milestones are free-form names (no
 * per-project setup) assigned from a task's detail rail.
 */
export function MilestonesView({ data, onOpenTask }: MilestonesViewProps) {
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const byName = new Map<string, MilestoneGroup>();
  for (const task of data.tasks) {
    const name = task.meta.milestone;
    if (name === null || name === '') continue;
    const group = byName.get(name) ?? { name, tasks: [], done: 0 };
    group.tasks.push(task);
    if (isClosed(task)) group.done += 1;
    byName.set(name, group);
  }
  const groups = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <h1 className="sr-only">Milestones</h1>

      {groups.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Target className="size-6" />
          <p className="text-[13px]">
            No milestones yet. Assign a task to a milestone from its detail
            panel to group work here.
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-2">
          {groups.map((group) => {
            const pct =
              group.tasks.length === 0
                ? 0
                : Math.round((group.done / group.tasks.length) * 100);
            const status = deriveMilestoneStatus(
              group.tasks,
              data.latestRunByTaskId,
              group.done === group.tasks.length
            );
            const stalled = status.health === 'stalled';
            return (
              <section
                key={group.name}
                className={cn(
                  'shadow-hairline flex flex-col rounded-lg',
                  stalled ? 'bg-state-waiting-surface' : 'bg-card'
                )}
              >
                <div className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Target className="text-primary size-4 shrink-0" />
                    <h2 className="text-foreground min-w-0 flex-1 truncate text-[14px] font-medium">
                      {group.name}
                    </h2>
                    <span
                      className={cn(
                        'dense-meta shrink-0',
                        stalled && 'text-state-waiting'
                      )}
                    >
                      {MILESTONE_HEALTH_LABEL[status.health]}
                    </span>
                    <span className="dense-meta shrink-0">
                      {group.done}/{group.tasks.length}
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-300',
                        pct === 100 ? 'bg-state-review' : 'bg-primary'
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {/* Never "at risk" without saying why — an unexplained warning is just
                      anxiety. There is no target date to be late against (milestones are
                      free-form names), so the reason is always about what is stuck. */}
                  {status.reason !== null && (
                    <div className="flex items-center gap-2">
                      <TriangleAlert className="text-state-waiting size-3.5 shrink-0" />
                      <span className="text-state-waiting text-[12.5px]">
                        {status.reason}
                      </span>
                    </div>
                  )}
                  {status.working > 0 && !stalled && (
                    <div className="flex items-center gap-2">
                      <StateDot state="working" />
                      <span className="text-muted-foreground text-[12.5px]">
                        {status.working} running
                      </span>
                    </div>
                  )}
                </div>
                <div className="border-border/60 flex flex-col gap-0.5 border-t p-1.5">
                  {group.tasks.map((task) => (
                    <button
                      key={task.meta.id}
                      type="button"
                      onClick={() => onOpenTask(task.meta.id)}
                      className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-150"
                    >
                      <PriorityIcon priority={task.meta.priority} />
                      <StatusIcon status={task.meta.status} />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[13px]',
                          isClosed(task)
                            ? 'text-muted-foreground'
                            : 'text-foreground'
                        )}
                      >
                        {task.meta.title}
                      </span>
                      {task.meta.kind === 'epic' && (
                        <span className="text-muted-foreground/70 shrink-0 text-[10px] uppercase">
                          epic
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
