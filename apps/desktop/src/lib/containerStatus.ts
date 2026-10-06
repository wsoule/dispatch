import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  isCanceledStatus,
  isCompletedStatus,
} from '@dispatch-foo/core/browser';

import { activeStatusModel } from './statusModel';
import type { TaskBucket } from './taskStatus';

export type ContainerHealth = 'attention' | 'moving' | 'idle' | 'finished';

export interface ContainerStatus {
  /** Open asks on its tasks: the same unit as the orb and "tasks ●". */
  asks: number;
  failed: number;
  working: number;
  review: number;
  /** The one done/total rule: completed only, dropped excluded. */
  done: number;
  total: number;
  /** The one health rule: attention means asks or failures. */
  health: ContainerHealth;
}

export function containerStatus(
  children: readonly TaskListItem[],
  ctx: {
    bucketOf: (doc: TaskListItem) => TaskBucket | null;
    asksByTask: ReadonlyMap<string, number>;
    model?: StatusModel;
  }
): ContainerStatus {
  const model = ctx.model ?? activeStatusModel();
  const s = { asks: 0, failed: 0, working: 0, review: 0, done: 0, total: 0 };
  for (const doc of children) {
    if (isCanceledStatus(doc.meta.status, model)) continue;
    s.total++;
    if (isCompletedStatus(doc.meta.status, model)) s.done++;
    s.asks += ctx.asksByTask.get(doc.meta.id) ?? 0;
    const bucket = ctx.bucketOf(doc);
    if (bucket === 'failed') s.failed++;
    else if (bucket === 'working') s.working++;
    else if (bucket === 'review') s.review++;
  }
  const health: ContainerHealth =
    s.asks + s.failed > 0
      ? 'attention'
      : s.working > 0
        ? 'moving'
        : s.total > 0 && s.done === s.total
          ? 'finished'
          : 'idle';
  return { ...s, health };
}
