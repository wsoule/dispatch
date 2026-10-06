import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isCompletedStatus } from '@dispatch-foo/core/browser';

import { activeStatusModel } from './statusModel';
import type { TaskBucket } from './taskStatus';

/** The Tasks view's presets: one question each about the work. */
export type TasksPreset =
  | 'all'
  | 'needs-you'
  | 'failed'
  | 'moving'
  | 'review'
  | 'ready'
  | 'landing'
  | 'landed'
  | 'starred';

export const TASKS_PRESETS: readonly { id: TasksPreset; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'failed', label: 'Failed' },
  { id: 'moving', label: 'Moving' },
  { id: 'review', label: 'Review' },
  { id: 'ready', label: 'Ready' },
  { id: 'landing', label: 'Landing' },
  { id: 'landed', label: 'Landed' },
  { id: 'starred', label: 'Starred' },
];

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
export function bucketForPreset(preset: TasksPreset): TaskBucket | null {
  return PRESET_BUCKET[preset] ?? null;
}

export interface PresetContext {
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  starred: ReadonlySet<string>;
}

/** A list predicate for a preset, or `undefined` for All. */
export function presetMatcher(
  preset: TasksPreset,
  ctx: PresetContext
): ((doc: TaskListItem) => boolean) | undefined {
  switch (preset) {
    case 'all':
      return undefined;
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
