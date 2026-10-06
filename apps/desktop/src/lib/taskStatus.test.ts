import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { needsYou } from './needsYou';
import { taskDoc } from './taskDoc.test-helper';
import {
  type BucketContext,
  itemBucket,
  TASK_BUCKET_ORDER,
  taskStatusCounts,
} from './taskStatus';

function task(id: string, status: string, over: object = {}): TaskListItem {
  return taskDoc({ id, title: id, status, ...over }) as TaskListItem;
}

function run(taskId: string, state: RunMeta['state']): RunMeta {
  return { id: `r-${taskId}`, taskId, state } as RunMeta;
}

function ctx(over: Partial<BucketContext> = {}): BucketContext {
  return {
    asking: new Set(),
    attention: new Map(),
    latestRun: new Map(),
    queued: new Set(),
    blocked: new Set(),
    ...over,
  };
}

describe('itemBucket', () => {
  test('an ask wins over every other state', () => {
    const c = ctx({
      asking: new Set(['t']),
      attention: new Map([['t', 'failed']]),
      latestRun: new Map([['t', run('t', 'running')]]),
    });
    expect(itemBucket(task('t', 'working'), c)).toBe('need-you');
  });

  test('then failed, working, review and landing', () => {
    expect(
      itemBucket(
        task('t', 'working'),
        ctx({ attention: new Map([['t', 'failed']]) })
      )
    ).toBe('failed');
    expect(
      itemBucket(
        task('t', 'working'),
        ctx({ latestRun: new Map([['t', run('t', 'running')]]) })
      )
    ).toBe('working');
    expect(
      itemBucket(
        task('t', 'review'),
        ctx({ attention: new Map([['t', 'review']]) })
      )
    ).toBe('review');
    expect(itemBucket(task('t', 'review'), ctx())).toBe('review');
    expect(
      itemBucket(task('t', 'review'), ctx({ queued: new Set(['t']) }))
    ).toBe('landing');
    expect(itemBucket(task('t', 'landing'), ctx())).toBe('landing');
  });

  test('a started task with no live run still reads as working', () => {
    expect(itemBucket(task('t', 'working'), ctx())).toBe('working');
  });

  test('ready and draft unless blocked', () => {
    expect(itemBucket(task('t', 'ready'), ctx())).toBe('ready');
    expect(itemBucket(task('t', 'draft'), ctx())).toBe('draft');
    expect(
      itemBucket(task('t', 'ready'), ctx({ blocked: new Set(['t']) }))
    ).toBe('blocked');
    expect(
      itemBucket(task('t', 'draft'), ctx({ blocked: new Set(['t']) }))
    ).toBe('blocked');
  });

  test('landed, dropped and containers are not open work', () => {
    expect(itemBucket(task('t', 'landed'), ctx())).toBeNull();
    expect(itemBucket(task('t', 'dropped'), ctx())).toBeNull();
    expect(
      itemBucket(task('m', 'working', { kind: 'milestone' }), ctx())
    ).toBeNull();
  });
});

describe('taskStatusCounts', () => {
  const tasks = [
    task('ask', 'working'),
    task('fail', 'working'),
    task('work', 'working'),
    task('rev', 'review'),
    task('land', 'landing'),
    task('ready', 'ready'),
    task('draft', 'draft'),
    task('blk', 'ready'),
    task('done', 'landed'),
    task('gone', 'dropped'),
    task('m', 'working', { kind: 'milestone' }),
  ];
  const c = ctx({
    asking: new Set(['ask']),
    attention: new Map([
      ['fail', 'failed'],
      ['rev', 'review'],
    ]),
    latestRun: new Map([['work', run('work', 'running')]]),
    blocked: new Set(['blk']),
  });

  test('every open task lands in exactly one bucket', () => {
    const counts = taskStatusCounts(tasks, c);
    const sum = TASK_BUCKET_ORDER.reduce((n, b) => n + counts.buckets[b], 0);
    expect(sum).toBe(counts.open);
    expect(counts.open).toBe(8);
    expect(counts.buckets).toEqual({
      'need-you': 1,
      failed: 1,
      working: 1,
      review: 1,
      landing: 1,
      ready: 1,
      draft: 1,
      blocked: 1,
    });
  });

  test('done/total counts completed only and leaves dropped out', () => {
    const counts = taskStatusCounts(tasks, c);
    expect(counts.landed).toBe(1);
    expect(counts.total).toBe(9);
  });

  test('tasks that need you never outnumber the asks', () => {
    const asks = needsYou(
      [
        {
          id: 'a',
          kind: 'doc',
          taskId: 'ask',
          summary: '',
          since: '',
          ageMs: 0,
          state: 'open',
          disposition: 'blocking',
        },
        {
          id: 'b',
          kind: 'question',
          runId: 'r',
          taskId: 'ask',
          summary: '',
          since: '',
          ageMs: 0,
          state: 'open',
          disposition: 'blocking',
        },
      ],
      null
    );
    const counts = taskStatusCounts(tasks, { ...c, asking: asks.taskIds });
    expect(counts.buckets['need-you']).toBeLessThanOrEqual(asks.count);
  });
});
