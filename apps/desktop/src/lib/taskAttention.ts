import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';

import { deriveFeedState, isUrgentState } from './feedState';

/** The subset of `FeedState` where a task's card/row earns the attention tint: the run is
 * waiting on the user (approval or question), stopped without finishing, or finished and
 * still owed a review. */
export type TaskAttention = 'waiting' | 'failed' | 'review';

/**
 * Which tasks need a human right now, keyed by task id — the task screen's counterpart to
 * the Control room feed's grouping. Reuses `deriveFeedState` so a run the queue is landing
 * doesn't read as "needs review", and mirrors `buildFeed`'s ask override: a task in
 * `askingTaskIds` (see `taskIdsWithOpenAsks`) is waiting on an answer.
 */
export function deriveTaskAttentionById(
  latestRunByTaskId: ReadonlyMap<string, RunMeta>,
  askingTaskIds: ReadonlySet<string>,
  mergeQueue: MergeQueueSnapshot | null
): Map<string, TaskAttention> {
  const queueByRunId = new Map(
    (mergeQueue?.entries ?? []).map((e) => [e.runId, e])
  );
  const result = new Map<string, TaskAttention>();
  for (const [taskId, run] of latestRunByTaskId) {
    const derived = deriveFeedState(run, queueByRunId.get(run.id));
    const asks = askingTaskIds.has(taskId);
    if (derived === null && !asks) continue;
    const state =
      asks && derived !== 'approve' ? 'answer' : (derived ?? 'answer');
    // TaskAttention keeps its own coarse trio: every your-move ask reads as
    // 'waiting' at this altitude, except review, which stays its softer self.
    if (state === 'review') result.set(taskId, 'review');
    else if (state === 'failed') result.set(taskId, 'failed');
    else if (isUrgentState(state)) result.set(taskId, 'waiting');
  }
  return result;
}
