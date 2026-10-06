import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  hasStatusRole,
  isBacklogStatus,
  isCanceledStatus,
  isCompletedStatus,
  isContainerKind,
  isDoneStatus,
  isStartedStatus,
} from '@dispatch-foo/core/browser';
import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';

import { isTerminalRunState } from './runState';
import { activeStatusModel } from './statusModel';
import type { TaskAttention } from './taskAttention';

/** Where an open task sits on the Tasks strip; the first match in this order wins. */
export type TaskBucket =
  | 'need-you'
  | 'failed'
  | 'working'
  | 'review'
  | 'landing'
  | 'ready'
  | 'draft'
  | 'blocked';

export const TASK_BUCKET_ORDER: readonly TaskBucket[] = [
  'need-you',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'draft',
  'blocked',
];

export interface BucketContext {
  /** Tasks with at least one ask of mine (`needsYou().taskIds`). */
  asking: ReadonlySet<string>;
  attention: ReadonlyMap<string, TaskAttention>;
  latestRun: ReadonlyMap<string, RunMeta>;
  queued: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  model?: StatusModel;
}

/** Tasks with an entry in the merge queue. */
export function queuedTaskIds(queue: MergeQueueSnapshot | null): Set<string> {
  return new Set((queue?.entries ?? []).map((e) => e.taskId));
}

/** An open task's one bucket, or `null` for finished work and containers. */
export function itemBucket(
  task: TaskListItem,
  ctx: BucketContext
): TaskBucket | null {
  const { id, status, kind } = task.meta;
  const model = ctx.model ?? activeStatusModel();
  if (isContainerKind(kind) || isDoneStatus(status, model)) return null;
  if (ctx.asking.has(id)) return 'need-you';
  const attention = ctx.attention.get(id);
  if (attention === 'failed') return 'failed';
  const run = ctx.latestRun.get(id);
  if (run !== undefined && !isTerminalRunState(run.state)) return 'working';
  if (ctx.queued.has(id) || hasStatusRole(status, 'landing', model)) {
    return 'landing';
  }
  if (attention === 'review' || hasStatusRole(status, 'review', model)) {
    return 'review';
  }
  if (isStartedStatus(status, model)) return 'working';
  if (ctx.blocked.has(id)) return 'blocked';
  return isBacklogStatus(status, model) ? 'draft' : 'ready';
}

export interface TaskStatusCounts {
  buckets: Record<TaskBucket, number>;
  /** Tasks in any bucket. */
  open: number;
  /** The one done/total rule: completed only, dropped excluded. */
  landed: number;
  total: number;
}

export function taskStatusCounts(
  tasks: readonly TaskListItem[],
  ctx: BucketContext
): TaskStatusCounts {
  const model = ctx.model ?? activeStatusModel();
  const buckets = Object.fromEntries(
    TASK_BUCKET_ORDER.map((b) => [b, 0])
  ) as Record<TaskBucket, number>;
  let open = 0;
  let landed = 0;
  let total = 0;
  for (const task of tasks) {
    if (isContainerKind(task.meta.kind)) continue;
    if (isCanceledStatus(task.meta.status, model)) continue;
    total++;
    if (isCompletedStatus(task.meta.status, model)) landed++;
    const bucket = itemBucket(task, ctx);
    if (bucket === null) continue;
    buckets[bucket]++;
    open++;
  }
  return { buckets, open, landed, total };
}
