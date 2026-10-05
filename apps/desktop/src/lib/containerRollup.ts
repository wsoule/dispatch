import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  isCanceledStatus,
  isCompletedStatus,
} from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';

import { activeStatusModel } from './statusModel';
import { executeRuns } from './taskPageMode';

/** The run that carried a task's work in: the merged one, else the one with a PR. */
export function landingRun(runs: readonly RunMeta[]): RunMeta | undefined {
  return (
    runs.find(
      (r) => r.reviewAction === 'merge' || r.mergeCommit !== undefined
    ) ?? runs.find((r) => r.prUrl !== undefined)
  );
}

interface SubIssueOutcome {
  task: TaskListItem;
  /** The run that landed it, when an agent did the work. */
  landedBy: RunMeta | undefined;
}

export interface ContainerRollup {
  subIssues: SubIssueOutcome[];
  landed: number;
  dropped: number;
  /** Neither completed nor canceled yet. */
  open: number;
  /** Every execute run across the sub-issues, newest first. */
  runs: RunMeta[];
}

/**
 * What a container's summary reads, rolled up from the work under it (the tasks its plan
 * draws): which sub-issues landed or were dropped, the run that landed each, and every
 * execute run behind them, for the totals. A container never runs an agent of its own.
 * Landed and dropped are by `model`, the project's statuses.
 */
export function containerRollup(
  work: readonly TaskListItem[],
  allRuns: readonly RunMeta[],
  model: StatusModel = activeStatusModel()
): ContainerRollup {
  const ids = new Set(work.map((t) => t.meta.id));
  const runs = executeRuns(allRuns.filter((r) => ids.has(r.taskId)));
  const runsByTask = new Map<string, RunMeta[]>();
  for (const run of runs) {
    const list = runsByTask.get(run.taskId);
    if (list === undefined) runsByTask.set(run.taskId, [run]);
    else list.push(run);
  }
  let landed = 0;
  let dropped = 0;
  const subIssues = work.map((task) => {
    if (isCompletedStatus(task.meta.status, model)) landed++;
    else if (isCanceledStatus(task.meta.status, model)) dropped++;
    return {
      task,
      landedBy: landingRun(runsByTask.get(task.meta.id) ?? []),
    };
  });
  return {
    subIssues,
    landed,
    dropped,
    open: work.length - landed - dropped,
    runs,
  };
}

/** The container's outcome in one line: `3 of 5 sub-issues landed · 1 dropped`. */
export function rollupOutcome(rollup: ContainerRollup): string {
  const total = rollup.subIssues.length;
  if (total === 0) return 'No sub-issues.';
  const parts = [
    `${rollup.landed} of ${total} sub-issue${total === 1 ? '' : 's'} landed`,
  ];
  if (rollup.dropped > 0) parts.push(`${rollup.dropped} dropped`);
  if (rollup.open > 0) parts.push(`${rollup.open} still open`);
  return parts.join(' · ');
}
