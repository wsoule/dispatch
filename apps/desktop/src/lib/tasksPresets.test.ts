import type { TaskListItem } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import { taskDoc } from './taskDoc.test-helper';
import {
  presetForBucket,
  presetMatcher,
  TASKS_PRESETS,
  type TasksPreset,
} from './tasksPresets';
import type { TaskBucket } from './taskStatus';

function task(id: string, status = 'ready'): TaskListItem {
  return taskDoc({ id, title: id, status }) as TaskListItem;
}

const BUCKET: Record<string, TaskBucket | null> = {
  ask: 'need-you',
  fail: 'failed',
  run: 'working',
  rev: 'review',
  queue: 'landing',
  go: 'ready',
  done: null,
};

function matches(preset: TasksPreset): string[] {
  const match = presetMatcher(preset, {
    bucketOf: (doc) => BUCKET[doc.meta.id] ?? null,
    starred: new Set(['go', 'done']),
  });
  const docs = [
    ...Object.keys(BUCKET)
      .filter((id) => id !== 'done')
      .map((id) => task(id)),
    task('done', 'landed'),
  ];
  return docs
    .filter((doc) => match === undefined || match(doc))
    .map((d) => d.meta.id);
}

describe('presetMatcher', () => {
  test('All shows everything', () => {
    expect(
      presetMatcher('all', { bucketOf: () => null, starred: new Set() })
    ).toBeUndefined();
  });

  test.each([
    ['needs-you', ['ask']],
    ['failed', ['fail']],
    ['moving', ['run']],
    ['review', ['rev']],
    ['landing', ['queue']],
    ['ready', ['go']],
    ['landed', ['done']],
    ['starred', ['go', 'done']],
  ] as const)('%p keeps %p', (preset, ids) => {
    expect(matches(preset)).toEqual([...ids]);
  });
});

describe('presetForBucket', () => {
  test('each top-bar state has a preset', () => {
    expect(presetForBucket('failed')).toBe('failed');
    expect(presetForBucket('review')).toBe('review');
    expect(presetForBucket('working')).toBe('moving');
    expect(presetForBucket('need-you')).toBe('needs-you');
  });

  test('every preset is listed once, All first', () => {
    const ids = TASKS_PRESETS.map((p) => p.id);
    expect(ids[0]).toBe('all');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
