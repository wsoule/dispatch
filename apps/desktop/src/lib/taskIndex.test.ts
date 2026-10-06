import type { TaskListItem } from '@dispatch-foo/core/browser';
import { expect, test } from 'bun:test';

import { blocksIn, childrenIn, taskIndexOf } from './taskIndex';

function task(
  id: string,
  meta: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      parent: null,
      blockedBy: [],
      labels: [],
      cycle: null,
      ...meta,
    },
  } as TaskListItem;
}

const CYCLE = (n: number) => ({
  id: `c-${n}`,
  number: n,
  name: null,
  startsAt: '',
  endsAt: '',
});

test('one pass indexes children, blockers, labels and cycles', () => {
  const tasks = [
    task('m-1'),
    task('t-1', { parent: 'm-1', labels: ['ui'], cycle: CYCLE(42) }),
    task('t-2', { parent: 'm-1', blockedBy: ['t-1'], labels: ['api', 'ui'] }),
    task('t-3', { blockedBy: ['t-1'], cycle: CYCLE(41) }),
  ];
  const index = taskIndexOf(tasks);
  expect(index.byId.get('t-2')?.meta.id).toBe('t-2');
  expect([...index.parentIds]).toEqual(['m-1']);
  expect(childrenIn(index, 'm-1').map((t) => t.meta.id)).toEqual([
    't-1',
    't-2',
  ]);
  expect(childrenIn(index, 't-3')).toEqual([]);
  expect(blocksIn(index, 't-1').map((t) => t.meta.id)).toEqual(['t-2', 't-3']);
  expect(index.labels).toEqual(['api', 'ui']);
  expect(index.cycles.map((c) => c.number)).toEqual([41, 42]);
});

test('the index is shared per list version', () => {
  const tasks = [task('t-1')];
  expect(taskIndexOf(tasks)).toBe(taskIndexOf(tasks));
  expect(taskIndexOf([...tasks])).not.toBe(taskIndexOf(tasks));
});
