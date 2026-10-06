import type { TaskListItem } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import { containerStatus } from './containerStatus';
import { taskDoc } from './taskDoc.test-helper';
import type { TaskBucket } from './taskStatus';

function task(id: string, status: string): TaskListItem {
  return taskDoc({ id, title: id, status }) as TaskListItem;
}

const BUCKETS: Record<string, TaskBucket | null> = {
  a: 'need-you',
  b: 'failed',
  c: 'working',
  d: 'review',
  e: 'ready',
};

function status(children: TaskListItem[], asks: Record<string, number> = {}) {
  return containerStatus(children, {
    bucketOf: (doc) => BUCKETS[doc.meta.id] ?? null,
    asksByTask: new Map(Object.entries(asks)),
  });
}

describe('containerStatus', () => {
  test('urgent counts use the top bar’s units: asks, then tasks per state', () => {
    const s = status(
      [
        task('a', 'working'),
        task('b', 'working'),
        task('c', 'working'),
        task('d', 'review'),
      ],
      { a: 2 }
    );
    expect([s.asks, s.failed, s.working, s.review]).toEqual([2, 1, 1, 1]);
  });

  test('done/total counts landed only and leaves dropped out', () => {
    const s = status([
      task('x', 'landed'),
      task('y', 'dropped'),
      task('e', 'ready'),
    ]);
    expect([s.done, s.total]).toEqual([1, 2]);
  });

  test('attention means asks or failures', () => {
    expect(status([task('b', 'working')]).health).toBe('attention');
    expect(status([task('a', 'working')], { a: 1 }).health).toBe('attention');
    expect(status([task('c', 'working')]).health).toBe('moving');
    expect(status([task('e', 'ready')]).health).toBe('idle');
    expect(status([task('x', 'landed'), task('y', 'dropped')]).health).toBe(
      'finished'
    );
  });

  test('an empty container is idle, not finished', () => {
    expect(status([]).health).toBe('idle');
  });
});
