import type { TaskListItem } from '@dispatch/core/browser';
import { parentIdsOf } from '@dispatch/core/browser';
import { expect, test } from 'bun:test';

import { ancestorsOf, parentCandidates } from './taskHierarchy';

function task(
  id: string,
  kind: string,
  parent: string | null = null
): TaskListItem {
  return { meta: { id, title: id, kind, parent } } as TaskListItem;
}

const TASKS = [
  task('i-1', 'initiative'),
  task('p-1', 'project', 'i-1'),
  task('m-1', 'milestone', 'p-1'),
  task('t-1', 'task', 'm-1'),
  task('t-2', 'task', 't-1'),
  task('t-3', 'task'),
];
const BY_ID = new Map(TASKS.map((t) => [t.meta.id, t]));

function byId(id: string): TaskListItem {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
}

test('ancestors run outermost first', () => {
  const sub = byId('t-2');
  expect(ancestorsOf(sub, BY_ID).map((t) => t.meta.id)).toEqual([
    'i-1',
    'p-1',
    'm-1',
    't-1',
  ]);
});

test('ancestors stop at a cycle', () => {
  const a = task('a', 'task', 'b');
  const b = task('b', 'task', 'a');
  const byId = new Map([
    ['a', a],
    ['b', b],
  ]);
  expect(ancestorsOf(a, byId).map((t) => t.meta.id)).toEqual(['b']);
});

test('a task may move under broader containers and parent issues, never below itself', () => {
  const t1 = byId('t-1');
  const ids = parentCandidates(t1, TASKS, parentIdsOf(TASKS)).map(
    (t) => t.meta.id
  );
  // t-2 is t-1's own sub-issue; t-3 has no children.
  expect(ids).toEqual(['i-1', 'p-1', 'm-1']);
});

test('a milestone only moves under projects and initiatives', () => {
  const m1 = byId('m-1');
  expect(
    parentCandidates(m1, TASKS, parentIdsOf(TASKS)).map((t) => t.meta.id)
  ).toEqual(['i-1', 'p-1']);
});
