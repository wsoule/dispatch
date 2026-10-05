import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';

import { activeStatusModel } from './statusModel';

/**
 * How many runs the "Merge all ready" toolbar button would enqueue right
 * now: finished, unreviewed, not routed to PR review, not already sitting
 * in the merge queue, and belonging to a task that isn't itself done/
 * cancelled — this part mirrors enqueueReady's own admission checks
 * server-side exactly. The blockedBy check on top of that is a
 * conservative client-side pre-filter, NOT a mirror of enqueueReady's
 * admission: the server happily enqueues a blocked run and only gates it
 * later, at pump time, via nextEligible's 'waiting-blockers' state — this
 * just avoids the button's count (and its one-shot enqueue) promising a
 * run that would immediately sit blocked in the queue. `tasks` must
 * include archived tasks (e.g. via `fetchTaskList({ archived: true })`) or an
 * archived own-task/blocker will be missing from `byId` and read as
 * "not done" here. Pure so the toolbar's count is unit-testable without a
 * live tasks/queue fetch. A task is resolved once done OR cancelled under `model` — the
 * same semantics as mergeQueue.ts's isDone checks server-side.
 */
export function countMergeReady(
  runs: RunMeta[],
  tasks: TaskListItem[],
  queued: Set<string>,
  model: StatusModel = activeStatusModel()
): number {
  const isTaskDone = (task: TaskListItem) =>
    isDoneStatus(task.meta.status, model);
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  let count = 0;
  for (const run of runs) {
    if (run.state !== 'finished') continue;
    if (run.reviewedAt !== undefined) continue;
    if (run.prUrl !== undefined) continue;
    if (queued.has(run.id)) continue;
    const task = byId.get(run.taskId);
    if (task !== undefined && isTaskDone(task)) continue;
    const blockedBy = task?.meta.blockedBy ?? [];
    const blockersDone = blockedBy.every((id) => {
      const blocker = byId.get(id);
      return blocker === undefined || isTaskDone(blocker);
    });
    if (!blockersDone) continue;
    count++;
  }
  return count;
}
