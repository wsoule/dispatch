import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isCompletedStatus } from '@dispatch-foo/core/browser';
import { TASKS_PRESETS, type TasksPreset } from '@dispatch/client';

import { personOf } from './cockpit';
import { activeStatusModel } from './statusModel';
import type { TaskBucket } from './taskStatus';

export { TASKS_PRESETS, type TasksPreset };

const BUCKET_PRESET: Partial<Record<TaskBucket, TasksPreset>> = {
  'need-you': 'needs-you',
  failed: 'failed',
  working: 'moving',
  review: 'review',
  ready: 'ready',
  landing: 'landing',
};

/** The preset a strip chip or a top-bar count opens. */
export function presetForBucket(bucket: TaskBucket): TasksPreset | null {
  return BUCKET_PRESET[bucket] ?? null;
}

const PRESET_BUCKET: Partial<Record<TasksPreset, TaskBucket>> = {
  'needs-you': 'need-you',
  failed: 'failed',
  moving: 'working',
  review: 'review',
  ready: 'ready',
  landing: 'landing',
};

/** The bucket a preset narrows to, when it is one. */
function bucketForPreset(preset: TasksPreset): TaskBucket | null {
  return PRESET_BUCKET[preset] ?? null;
}

export interface PresetContext {
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  starred: ReadonlySet<string>;
  /** This window's own ref, for Mine; null until the daemon says (Mine then matches none). */
  me?: string | null;
}

/** A list predicate for a preset, or `undefined` for All. */
export function presetMatcher(
  preset: TasksPreset,
  ctx: PresetContext
): ((doc: TaskListItem) => boolean) | undefined {
  switch (preset) {
    case 'all':
      return undefined;
    case 'mine': {
      // The Cockpit's Mine: work assigned to me, the legacy bare `human` included.
      const me = ctx.me ?? null;
      return (doc) => me !== null && personOf(doc.meta.assignee, me) === me;
    }
    case 'starred':
      return (doc) => ctx.starred.has(doc.meta.id);
    case 'landed':
      return (doc) => isCompletedStatus(doc.meta.status, activeStatusModel());
    default: {
      const bucket = bucketForPreset(preset);
      return (doc) => ctx.bucketOf(doc) === bucket;
    }
  }
}
