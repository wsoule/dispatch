import type {
  MergeQueueSnapshot,
  RunMeta,
  RunQuestion,
} from '@dispatch/client';

import { deriveFeedState, isUrgentState } from './feedState';

/** The subset of `FeedState` where a task's card/row earns the attention tint: the run is
 * waiting on the user (approval or question), stopped without finishing, or finished and
 * still owed a review. */
export type TaskAttention = 'waiting' | 'failed' | 'review';

/**
 * Which tasks need a human right now, keyed by task id — the task screen's counterpart to
 * the Control room feed's grouping. Reuses `deriveFeedState` so a run the queue is landing
 * doesn't read as "needs review", and mirrors `buildFeed`'s question override: a run blocked
 * on an unanswered question still reads 'running' in its own metadata.
 */
export function deriveTaskAttentionById(
  latestRunByTaskId: ReadonlyMap<string, RunMeta>,
  openQuestions: ReadonlyMap<string, RunQuestion[]>,
  mergeQueue: MergeQueueSnapshot | null
): Map<string, TaskAttention> {
  const queueByRunId = new Map(
    (mergeQueue?.entries ?? []).map((e) => [e.runId, e])
  );
  const result = new Map<string, TaskAttention>();
  for (const [taskId, run] of latestRunByTaskId) {
    const derived = deriveFeedState(run, queueByRunId.get(run.id));
    if (derived === null) continue;
    const asked = openQuestions.get(run.id) ?? [];
    const state =
      derived === 'working' && asked.length > 0 ? 'answer' : derived;
    // TaskAttention keeps its own coarse trio: every your-move ask reads as
    // 'waiting' at this altitude, except review, which stays its softer self.
    if (state === 'review') result.set(taskId, 'review');
    else if (state === 'failed') result.set(taskId, 'failed');
    else if (isUrgentState(state)) result.set(taskId, 'waiting');
  }
  return result;
}
