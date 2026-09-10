import type { TaskDoc } from '@dispatch/core/browser';
import { statusLabel } from '@dispatch/core/browser';
import { ChevronRight, Target, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import { StatusIcon } from '../components/tasks/StatusIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveMilestoneStatus } from '../lib/milestoneRisk';
import {
  isMilestoneFinished,
  rollupMilestoneStatus,
} from '../lib/milestoneRollup';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { ProgressTrack } from '@/ui/chrome/ProgressTrack';
import { StateDot } from '@/ui/chrome/StateDot';

interface MilestonesViewProps {
  data: DispatchProjectData;
  onOpenTask: (taskId: string) => void;
}

function isClosed(task: TaskDoc): boolean {
  return task.meta.status === 'landed' || task.meta.status === 'dropped';
}

interface MilestoneGroup {
  epic: TaskDoc;
  children: TaskDoc[];
  done: number;
  /** The milestone's own rolled-up pipeline state — see `rollupMilestoneStatus`. */
  rollup: string;
  finished: boolean;
}

/**
 * Milestones view — each milestone rendered as a big task: the epic wears its own rolled-up
 * pipeline state (the same status glyph vocabulary its children use, via
 * `rollupMilestoneStatus`), a progress track, and its tasks inside. A finished milestone
 * (every child landed/dropped) reads as landed: checked glyph, dimmed, collapsed, and
 * sorted to the bottom. Milestone = epic here, front-running the epic→milestone rename
 * (e-be4827) — the old free-form `meta.milestone` string grouping is retired.
 */
export function MilestonesView({ data, onOpenTask }: MilestonesViewProps) {
  // Which milestones the user has flipped away from their default expansion (unfinished
  // start open, finished start collapsed).
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  const groups = useMemo<MilestoneGroup[]>(() => {
    const childrenByEpic = new Map<string, TaskDoc[]>();
    for (const doc of data.tasks) {
      if (doc.meta.kind === 'epic' || doc.meta.parent === null) continue;
      const bucket = childrenByEpic.get(doc.meta.parent);
      if (bucket !== undefined) bucket.push(doc);
      else childrenByEpic.set(doc.meta.parent, [doc]);
    }
    const result = data.epics.map((epic) => {
      const children = childrenByEpic.get(epic.meta.id) ?? [];
      return {
        epic,
        children,
        done: children.filter(isClosed).length,
        rollup: rollupMilestoneStatus(children),
        finished: isMilestoneFinished(children),
      };
    });
    // Finished milestones sink to the bottom; everything else keeps the project's epic order.
    return [
      ...result.filter((g) => !g.finished),
      ...result.filter((g) => g.finished),
    ];
  }, [data.tasks, data.epics]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function toggle(id: string) {
    setToggledIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {groups.length === 0 ? (
        <EmptyState
          icon={Target}
          message="No milestones yet. “Plan work…” drafts one with its tasks."
          className="flex-1 justify-center gap-2 p-0 text-[13px] [&_[data-slot=empty-description]]:text-[length:inherit] [&_[data-slot=empty-icon]_svg]:size-6"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => {
            const expanded = toggledIds.has(group.epic.meta.id)
              ? group.finished
              : !group.finished;
            const pct =
              group.children.length === 0
                ? 0
                : group.done / group.children.length;
            const status = deriveMilestoneStatus(
              group.children,
              data.latestRunByTaskId,
              group.finished
            );
            const stalled = status.health === 'stalled';
            return (
              <div
                key={group.epic.meta.id}
                className={cn(
                  // `shrink-0` matters: these are flex children of an overflow-y-auto
                  // column, and the default flex-shrink would squash every card to fit.
                  'bg-card rounded-card shadow-card shrink-0 overflow-hidden',
                  group.finished && 'opacity-60 saturate-50'
                )}
              >
                <div className="flex flex-col gap-2 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggle(group.epic.meta.id)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.epic.meta.title}`}
                      className="text-muted-foreground shrink-0"
                    >
                      <ChevronRight
                        className={cn(
                          'size-3.5 transition-transform',
                          expanded && 'rotate-90'
                        )}
                      />
                    </Button>
                    {/* The milestone wears its rolled-up state in the same glyph
                        vocabulary as its tasks — a big task, not a different species. */}
                    <StatusIcon status={group.rollup} className="size-4" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onOpenTask(group.epic.meta.id)}
                      className="text-foreground h-auto min-w-0 flex-1 justify-start px-0 text-left text-[14px] font-medium hover:bg-transparent"
                    >
                      <span className="min-w-0 truncate">
                        {group.epic.meta.title}
                      </span>
                    </Button>
                    <span className="dense-meta shrink-0 capitalize">
                      {statusLabel(group.rollup)}
                    </span>
                    <span className="dense-meta shrink-0">
                      {group.done}/{group.children.length}
                    </span>
                    <PriorityIcon
                      priority={group.epic.meta.priority}
                      className="size-3.5 shrink-0"
                    />
                  </div>
                  <ProgressTrack
                    value={pct}
                    label={`${group.epic.meta.title} progress`}
                    className={cn(
                      'bg-muted h-1 rounded-full',
                      '[&>[data-slot=progress-indicator]]:transition-transform [&>[data-slot=progress-indicator]]:duration-300',
                      group.finished
                        ? '[&>[data-slot=progress-indicator]]:bg-state-review'
                        : '[&>[data-slot=progress-indicator]]:bg-primary'
                    )}
                  />
                  {/* Never "at risk" without saying why — an unexplained warning is just
                      anxiety. */}
                  {stalled && status.reason !== null && (
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
                {expanded && group.children.length > 0 && (
                  <div className="border-border/60 bg-surface-inset flex flex-col gap-0.5 border-t p-1.5">
                    {group.children.map((task) => (
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
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
