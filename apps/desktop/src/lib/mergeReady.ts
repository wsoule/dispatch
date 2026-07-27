import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

// Mirrors mergeQueue.ts's enqueueReady()/nextEligible() eligibility rules
// server-side: a task's blocker (or the run's own task) counts as resolved
// once it's done OR cancelled — the same isDone semantics the server's
// blocker-gating and own-task guard both use.
function isTaskDone(task: TaskDoc): boolean {
  return task.meta.status === 'done' || task.meta.status === 'cancelled';
}

/**
 * How many runs the "Merge all ready" toolbar button would enqueue right
 * now: finished, unreviewed, not routed to PR review, not already sitting
 * in the merge queue, and — mirroring enqueueReady's server-side
 * eligibility — belonging to a task that isn't itself done/cancelled and
 * whose blockers are all done/cancelled. Pure so the toolbar's count is
 * unit-testable without a live tasks/queue fetch.
 */
export function countMergeReady(
  runs: RunMeta[],
  tasks: TaskDoc[],
  queued: Set<string>
): number {
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
