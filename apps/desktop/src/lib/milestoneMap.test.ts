import type { TaskListItem } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import type { ListGroup } from './listGrouping';
import { milestoneMap, milestoneMix } from './milestoneMap';
import { taskDoc } from './taskDoc.test-helper';
import type { TaskBucket } from './taskStatus';

function task(id: string, blockedBy: string[] = []): TaskListItem {
  return taskDoc({ id, title: id, blockedBy }) as TaskListItem;
}

function group(
  epicId: string | null,
  label: string,
  tasks: TaskListItem[]
): ListGroup {
  return {
    key: epicId === null ? 'epic:none' : `milestone:${epicId}`,
    kind: 'milestone',
    label,
    tint: null,
    icon: { kind: 'epic', epicId },
    rows: tasks.map((doc) => ({ doc, indent: 0 })),
    preset: {},
    epicId,
    archived: false,
  } as ListGroup;
}

describe('milestoneMap', () => {
  const groups = [
    group('m1', 'M1 · Checkout', [task('a'), task('b')]),
    group('m2', 'M2 · Auth', [task('c', ['a']), task('d', ['a', 'b'])]),
    group('m3', 'M3 · Search', [task('e', ['c'])]),
    group(null, 'No milestone', [task('f', ['e'])]),
  ];

  test('milestones are nodes; loose tasks are not', () => {
    const map = milestoneMap(groups);
    expect(map.nodes.map((n) => [n.id, n.title])).toEqual([
      ['m1', 'M1 · Checkout'],
      ['m2', 'M2 · Auth'],
      ['m3', 'M3 · Search'],
    ]);
  });

  test('an edge means a task in one waits on a task in another, counted', () => {
    const map = milestoneMap(groups);
    expect(map.edges).toEqual([
      { from: 'm1', to: 'm2', count: 3 },
      { from: 'm2', to: 'm3', count: 1 },
    ]);
    expect(map.nodes.find((n) => n.id === 'm2')?.blockedBy).toEqual(['m1']);
  });

  test('waits inside one milestone are not edges', () => {
    const map = milestoneMap([
      group('m1', 'M1', [task('a'), task('b', ['a'])]),
    ]);
    expect(map.edges).toEqual([]);
  });

  test('each node keeps its tasks for its body and drill-down', () => {
    expect(
      milestoneMap(groups)
        .childrenOf.get('m2')
        ?.map((t) => t.meta.id)
    ).toEqual(['c', 'd']);
  });
});

describe('milestoneMix', () => {
  const doc = (id: string, status = 'ready') =>
    taskDoc({ id, title: id, status }) as TaskListItem;
  const buckets: Record<string, TaskBucket | null> = {
    r1: 'ready',
    r2: 'ready',
    w: 'working',
    n: 'need-you',
    f: 'failed',
    v: 'review',
    l: 'landing',
    d: 'draft',
    b: 'blocked',
  };
  const bucketOf = (t: TaskListItem) => buckets[t.meta.id] ?? null;

  test('counts each task once by where it stands; dropped work is left out', () => {
    const { mix } = milestoneMix(
      [
        doc('done', 'landed'),
        doc('gone', 'dropped'),
        ...Object.keys(buckets).map((id) => doc(id)),
      ],
      { bucketOf }
    );
    expect(mix).toEqual({
      landed: 1,
      landing: 1,
      review: 1,
      working: 1,
      needYou: 1,
      failed: 1,
      ready: 2,
      waiting: 2,
    });
  });

  test('open tasks come most urgent first, list order within a state', () => {
    const { open } = milestoneMix(
      [
        doc('d'),
        doc('r1'),
        doc('v'),
        doc('done', 'landed'),
        doc('n'),
        doc('r2'),
      ],
      { bucketOf }
    );
    expect(open.map((t) => t.meta.id)).toEqual(['n', 'v', 'r1', 'r2', 'd']);
  });

  test('next is the first ready task in list order', () => {
    expect(
      milestoneMix([doc('w'), doc('r2'), doc('r1')], { bucketOf }).next?.meta.id
    ).toBe('r2');
    expect(milestoneMix([doc('w')], { bucketOf }).next).toBeNull();
  });
});
