import type { TaskDoc } from '@dispatch/core/browser';
import { Target, TriangleAlert } from 'lucide-react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import { StatusIcon } from '../components/tasks/StatusIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  deriveMilestoneStatus,
  MILESTONE_HEALTH_LABEL,
} from '../lib/milestoneRisk';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState, Panel } from '@/ui/chrome';
import { ProgressTrack } from '@/ui/chrome/ProgressTrack';
import { StateDot } from '@/ui/chrome/StateDot';

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
        <EmptyState
          icon={Target}
          message="No milestones yet. Assign a task to a milestone from its detail panel to group work here."
          className="flex-1 justify-center gap-2 p-0 text-[13px] [&_[data-slot=empty-description]]:text-[length:inherit] [&_[data-slot=empty-icon]_svg]:size-6"
        />
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
              <Panel
                key={group.name}
                className={cn(
                  'flex flex-col',
                  stalled && 'bg-state-waiting-surface'
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
                  <ProgressTrack
                    value={pct / 100}
                    label={`${group.name} milestone progress`}
                    className={cn(
                      'bg-muted h-1.5 rounded-full',
                      '[&>[data-slot=progress-indicator]]:transition-transform [&>[data-slot=progress-indicator]]:duration-300',
                      pct === 100
                        ? '[&>[data-slot=progress-indicator]]:bg-state-review'
                        : '[&>[data-slot=progress-indicator]]:bg-primary'
                    )}
                  />
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
                    <Button
                      key={task.meta.id}
                      variant="ghost"
                      size="xs"
                      onClick={() => onOpenTask(task.meta.id)}
                      className="hover:bg-surface-hover hover:text-foreground rounded-control h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left text-[length:inherit] font-normal has-[>svg]:px-2.5"
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
                    </Button>
                  ))}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
