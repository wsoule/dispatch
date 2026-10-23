import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  DEFAULT_STATUS_MODEL,
  statusModelOf,
} from '@dispatch-foo/core/browser';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  chartStateOf,
  dependencyChart,
  drawnTasks,
  traceChart,
} from './dependencyChart';
import type { ListGroup } from './listGrouping';
import { milestoneMap } from './milestoneMap';
import { setActiveStatusModel } from './statusModel';
import { taskDoc } from './taskDoc.test-helper';
import type { TaskBucket } from './taskStatus';

afterEach(() => setActiveStatusModel(null));

// A Linear-style vocabulary, where none of the built-in status names mean anything.
const linear = statusModelOf({
  statuses: ['Todo', 'Done', 'Canceled'],
  statusDefinitions: [
    { name: 'Todo', type: 'unstarted', color: null },
    { name: 'Done', type: 'completed', color: null },
    { name: 'Canceled', type: 'canceled', color: null },
  ],
});

function task(
  id: string,
  status = 'ready',
  blockedBy: string[] = []
): TaskListItem {
  return taskDoc({
    id,
    title: `Task ${id}`,
    status,
    blockedBy,
  }) as TaskListItem;
}

function group(
  epicId: string | null,
  label: string,
  tasks: TaskListItem[],
  archived = false
): ListGroup {
  return {
    key: archived
      ? 'archived'
      : epicId === null
        ? 'epic:none'
        : `milestone:${epicId}`,
    kind: archived ? 'archived' : 'milestone',
    label,
    tint: null,
    icon: { kind: 'epic', epicId },
    rows: tasks.map((doc) => ({ doc, indent: 0 })),
    preset: {},
    epicId,
    archived,
  } as ListGroup;
}

// One flat milestone, for tests that only care about links.
function chart(
  tasks: TaskListItem[],
  buckets: Record<string, TaskBucket> = {}
) {
  return chartOf([group('m1', 'M1', tasks)], buckets);
}

function chartOf(
  groups: ListGroup[],
  buckets: Record<string, TaskBucket> = {}
) {
  return dependencyChart(groups, {
    bucketOf: (doc) => buckets[doc.meta.id] ?? null,
    model: DEFAULT_STATUS_MODEL,
  });
}

// a → b, a → c, b → d, c → d, d → e (a diamond with a tail), plus a lone x → y.
const diamond = [
  task('a'),
  task('b', 'ready', ['a']),
  task('c', 'ready', ['a']),
  task('d', 'ready', ['b', 'c']),
  task('e', 'ready', ['d']),
  task('x'),
  task('y', 'ready', ['x']),
];

describe('dependencyChart', () => {
  test('tasks come in group then row order; loose tasks in, archived groups out', () => {
    const model = chartOf([
      group('m1', 'M1 · Checkout', [task('a'), task('b')]),
      group('m2', 'M2 · Auth', [task('c')]),
      group(null, 'No milestone', [task('d')]),
      group(null, 'Archived', [task('e')], true),
    ]);
    expect(model.order).toEqual(['a', 'b', 'c', 'd']);
    expect([...model.tasks.keys()]).toEqual(['a', 'b', 'c', 'd']);
    const a = model.tasks.get('a');
    expect([a?.milestoneId, a?.milestoneTitle, a?.title]).toEqual([
      'm1',
      'M1 · Checkout',
      'Task a',
    ]);
    const d = model.tasks.get('d');
    expect([d?.milestoneId, d?.milestoneTitle]).toEqual([null, 'No milestone']);
  });

  test('a task listed in two groups keeps its first', () => {
    const model = chartOf([
      group('m1', 'M1', [task('a')]),
      group('m2', 'M2', [task('a', 'working')]),
    ]);
    expect(model.order).toEqual(['a']);
    expect(model.tasks.get('a')?.milestoneId).toBe('m1');
    expect(model.tasks.get('a')?.status).toBe('ready');
  });

  test('a canceled first occurrence keeps the task out, whatever a later row says', () => {
    const model = chartOf([
      group('m1', 'M1', [task('a', 'dropped'), task('b', 'ready', ['a'])]),
      group('m2', 'M2', [task('a')]),
    ]);
    expect(model.order).toEqual(['b']);
    expect(model.edges).toEqual([]);
    expect(model.hiddenBlockersOf.get('b')).toEqual(['a']);
  });

  test("reads the project's own status types, a passed model before the active one", () => {
    const groups = [
      group('m1', 'M1', [
        task('a', 'Done'),
        task('b', 'Todo', ['a']),
        task('c', 'Canceled', ['b']),
        task('d', 'Todo', ['b']),
      ]),
    ];
    const bucketOf = () => 'ready' as const;
    setActiveStatusModel(linear);
    const active = dependencyChart(groups, { bucketOf });
    expect(active.order).toEqual(['a', 'b', 'd']);
    expect(active.order.map((id) => active.tasks.get(id)?.state)).toEqual([
      'landed',
      'ready',
      'ready',
    ]);
    expect(active.longestChain).toEqual(['b', 'd']);
    // A passed model wins: under the built-in vocabulary nothing here is done or dropped.
    const passed = dependencyChart(groups, {
      bucketOf,
      model: DEFAULT_STATUS_MODEL,
    });
    expect(passed.order).toEqual(['a', 'b', 'c', 'd']);
    expect(passed.longestChain).toEqual(['a', 'b', 'c']);
  });

  test('canceled tasks are left out, and so are their links', () => {
    const model = chartOf([
      group('m1', 'M1', [task('a'), task('x', 'dropped', ['a'])]),
      group('m2', 'M2', [task('b', 'ready', ['x', 'a'])]),
    ]);
    expect(model.order).toEqual(['a', 'b']);
    expect(model.edges).toEqual([['a', 'b']]);
    expect(model.dependentsOf.get('a')).toEqual(['b']);
    expect(model.hiddenBlockersOf.get('b')).toEqual(['x']);
  });

  test('edges run blocker → blocked, de-duplicated, without self-loops', () => {
    const model = chart([
      task('a'),
      task('b'),
      task('c', 'ready', ['b', 'a', 'b', 'c']),
      task('d', 'ready', ['a']),
    ]);
    expect(model.edges).toEqual([
      ['b', 'c'],
      ['a', 'c'],
      ['a', 'd'],
    ]);
    expect(model.blockersOf.get('c')).toEqual(['b', 'a']);
    expect(model.dependentsOf.get('a')).toEqual(['c', 'd']);
    // Every task has both entries, even when empty.
    expect(model.order.map((id) => model.blockersOf.get(id))).toEqual([
      [],
      [],
      ['b', 'a'],
      ['a'],
    ]);
    expect(model.order.map((id) => model.dependentsOf.get(id))).toEqual([
      ['c', 'd'],
      ['c'],
      [],
      [],
    ]);
  });

  test('blockers outside the view are hidden blockers, once each, on the tasks that have them', () => {
    const model = chartOf([
      group('m1', 'M1', [
        task('a'),
        task('c', 'ready', ['ghost', 'a', 'ghost', 'old']),
      ]),
      group(null, 'Archived', [task('old')], true),
    ]);
    expect([...model.hiddenBlockersOf]).toEqual([['c', ['ghost', 'old']]]);
    expect(model.edges).toEqual([['a', 'c']]);
  });

  test('linked tasks have an edge either way; unlinkedOpen is the rest not landed', () => {
    const model = chart([
      task('a'),
      task('b'),
      task('c', 'ready', ['b', 'a']),
      task('s', 'ready', ['s']),
      task('d', 'landed'),
      task('e', 'working'),
    ]);
    // In model order, not edge order; a self-loop alone links nothing.
    expect([...model.linked]).toEqual(['a', 'b', 'c']);
    expect(model.unlinkedOpen).toEqual(['s', 'e']);
  });

  test('a task is drawn by its bucket, landed when completed', () => {
    const model = chart(
      [
        task('r1'),
        task('w', 'working'),
        task('n'),
        task('v', 'review'),
        task('done', 'landed'),
        task('f'),
        task('l', 'landing'),
        task('r2'),
        task('b'),
        task('box'),
      ],
      {
        r1: 'ready',
        w: 'working',
        n: 'need-you',
        v: 'review',
        done: 'ready',
        f: 'failed',
        l: 'landing',
        r2: 'ready',
        b: 'blocked',
      }
    );
    expect(model.order.map((id) => model.tasks.get(id)?.state)).toEqual([
      'ready',
      'working',
      'need-you',
      'review',
      'landed',
      'failed',
      'landing',
      'ready',
      'blocked',
      'draft',
    ]);
    expect(model.readyNow).toEqual(['r1', 'r2']);
    expect(model.inProgress).toEqual(['w', 'v', 'l']);
    expect(model.needsYou).toEqual(['n', 'f']);
  });
});

describe('chartStateOf', () => {
  test('completed is landed whatever the bucket; no bucket is draft', () => {
    const model = DEFAULT_STATUS_MODEL;
    expect(chartStateOf(task('a', 'landed'), 'ready', model)).toBe('landed');
    expect(chartStateOf(task('a', 'landed'), null, model)).toBe('landed');
    expect(chartStateOf(task('a', 'review'), 'need-you', model)).toBe(
      'need-you'
    );
    expect(chartStateOf(task('a'), 'blocked', model)).toBe('blocked');
    const box = taskDoc({ id: 'm', title: 'M', kind: 'milestone' });
    expect(chartStateOf(box as TaskListItem, null, model)).toBe('draft');
  });

  test('without a model it reads the active one', () => {
    expect(chartStateOf(task('a', 'Done'), 'ready')).toBe('ready');
    setActiveStatusModel(linear);
    expect(chartStateOf(task('a', 'Done'), 'ready')).toBe('landed');
    expect(chartStateOf(task('a', 'Todo'), null)).toBe('draft');
  });
});

describe('longestChain', () => {
  test('follows the longest open run through a diamond and its tail', () => {
    // a → b and a → c tie into d; the earlier dependent wins.
    expect(chart(diamond).longestChain).toEqual(['a', 'b', 'd', 'e']);
  });

  test('landed tasks break a chain', () => {
    const model = chart([
      task('a', 'landed'),
      task('b', 'ready', ['a']),
      task('c', 'ready', ['b']),
      task('d', 'landed', ['c']),
    ]);
    expect(model.longestChain).toEqual(['b', 'c']);
  });

  test('a cycle still ends, its back link skipped', () => {
    const model = chart([
      task('a', 'ready', ['c']),
      task('b', 'ready', ['a']),
      task('c', 'ready', ['b']),
      task('d', 'ready', ['c']),
    ]);
    expect(model.longestChain).toEqual(['a', 'b', 'c', 'd']);
    expect(
      chart([task('p', 'ready', ['q']), task('q', 'ready', ['p'])]).longestChain
    ).toEqual(['p', 'q']);
  });

  test('a cycle fed from outside keeps its lead-in, wherever the feeder sits in order', () => {
    // a → b → c → a, and d → b with d last: the run enters the cycle at d.
    const model = chart([
      task('a', 'ready', ['c']),
      task('b', 'ready', ['a', 'd']),
      task('c', 'ready', ['b']),
      task('d'),
    ]);
    expect(model.longestChain).toEqual(['d', 'b', 'c', 'a']);
  });

  test('a chain never repeats a task, even through tangled cycles', () => {
    const model = chart([
      task('a', 'ready', ['d']),
      task('b', 'ready', ['a', 'c']),
      task('c', 'ready', ['a', 'b']),
      task('d', 'ready', ['b', 'c']),
    ]);
    const chain = model.longestChain;
    expect(new Set(chain).size).toBe(chain.length);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < chain.length; i++) {
      expect(model.dependentsOf.get(chain[i - 1])).toContain(chain[i]);
    }
  });

  test('ties go to the chain that starts earliest in order', () => {
    const pq = group('m1', 'M1', [task('p'), task('q', 'ready', ['p'])]);
    const xy = group('m2', 'M2', [task('x'), task('y', 'ready', ['x'])]);
    expect(chartOf([pq, xy]).longestChain).toEqual(['p', 'q']);
    expect(chartOf([xy, pq]).longestChain).toEqual(['x', 'y']);
  });

  test('no edge between two open tasks is no chain', () => {
    expect(chart([task('a'), task('b')]).longestChain).toEqual([]);
    expect(
      chart([task('a', 'landed'), task('b', 'ready', ['a'])]).longestChain
    ).toEqual([]);
  });
});

describe('traceChart', () => {
  const model = chart(diamond);

  test('up walks blockers, down walks dependents, nearest first', () => {
    expect([...traceChart(model, 'e', 'up')]).toEqual(['d', 'b', 'c', 'a']);
    expect([...traceChart(model, 'a', 'down')]).toEqual(['b', 'c', 'd', 'e']);
    expect([...traceChart(model, 'd', 'down')]).toEqual(['e']);
    expect(traceChart(model, 'a', 'up').size).toBe(0);
    expect(traceChart(model, 'nope', 'down').size).toBe(0);
  });

  test('a cycle ends, and leads back to the task itself', () => {
    const loop = chart([
      task('a', 'ready', ['c']),
      task('b', 'ready', ['a']),
      task('c', 'ready', ['b']),
    ]);
    expect([...traceChart(loop, 'a', 'down')]).toEqual(['b', 'c', 'a']);
    expect([...traceChart(loop, 'a', 'up')]).toEqual(['c', 'b', 'a']);
  });
});

describe('drawnTasks', () => {
  // a (landed) → b; c is open and unlinked; d is landed and unlinked.
  const model = chart([
    task('a', 'landed'),
    task('b', 'ready', ['a']),
    task('c'),
    task('d', 'landed'),
  ]);

  test('linked tasks, plus unlinked open ones on request, landed ones hidden on request', () => {
    const drawn = (hideLanded: boolean, showUnlinked: boolean) =>
      drawnTasks(model, { hideLanded, showUnlinked });
    expect(drawn(false, false)).toEqual(['a', 'b']);
    expect(drawn(false, true)).toEqual(['a', 'b', 'c']);
    expect(drawn(true, false)).toEqual(['b']);
    expect(drawn(true, true)).toEqual(['b', 'c']);
  });

  test('with nothing linked every task is drawn', () => {
    const loose = chart([task('c'), task('d', 'landed'), task('e')]);
    for (const showUnlinked of [false, true]) {
      expect(drawnTasks(loose, { hideLanded: false, showUnlinked })).toEqual([
        'c',
        'd',
        'e',
      ]);
      expect(drawnTasks(loose, { hideLanded: true, showUnlinked })).toEqual([
        'c',
        'e',
      ]);
    }
  });
});

describe('milestonePairs', () => {
  // Waits across milestones (some on or from dropped tasks, one listed twice), inside one, to
  // and from loose tasks, from archived work and from ids no group holds.
  const groups = [
    group('m1', 'M1', [
      task('a'),
      task('b', 'landed'),
      task('x', 'dropped'),
      task('a2', 'ready', ['a']),
    ]),
    group('m2', 'M2', [
      task('c', 'ready', ['a']),
      task('d', 'ready', ['a', 'b', 'ghost']),
      task('y', 'dropped', ['b']),
      task('z', 'ready', ['x', 'c']),
    ]),
    group('m3', 'M3', [
      task('e', 'ready', ['c', 'f']),
      task('e2', 'ready', ['d', 'a', 'old', 'd']),
    ]),
    group(null, 'No milestone', [task('f', 'ready', ['e']), task('g')]),
    group(null, 'Archived', [task('old', 'ready', ['a'])], true),
  ];
  const model = chartOf(groups);

  test('pairs match milestoneMap edge for edge', () => {
    const { edges } = milestoneMap(groups);
    expect([...model.milestonePairs.keys()]).toEqual(
      edges.map((e) => `${e.from}\u0000${e.to}`)
    );
    for (const edge of edges) {
      expect(
        model.milestonePairs.get(`${edge.from}\u0000${edge.to}`)?.length
      ).toBe(edge.count);
    }
  });

  test('pairs are blocker → blocked, waits on or from dropped tasks left out', () => {
    // y (dropped) waits on b and z waits on x (dropped): neither wait is counted.
    expect(model.milestonePairs.get('m1\u0000m2')).toEqual([
      ['a', 'c'],
      ['a', 'd'],
      ['b', 'd'],
    ]);
    for (const pairs of model.milestonePairs.values()) {
      for (const [from, to] of pairs) {
        expect(model.tasks.has(from)).toBe(true);
        expect(model.tasks.has(to)).toBe(true);
      }
    }
    // The repeated d is counted twice, as milestoneMap counts it, though it is one edge.
    expect(model.milestonePairs.get('m2\u0000m3')).toEqual([
      ['c', 'e'],
      ['d', 'e2'],
      ['d', 'e2'],
    ]);
    expect(model.milestonePairs.get('m1\u0000m3')).toEqual([['a', 'e2']]);
    expect(model.edges.filter(([, to]) => to === 'e2')).toEqual([
      ['d', 'e2'],
      ['a', 'e2'],
    ]);
  });

  test('loose tasks and waits inside one milestone form no pairs', () => {
    for (const key of model.milestonePairs.keys()) {
      const [from, to] = key.split('\u0000');
      expect(from).not.toBe(to);
      expect(['m1', 'm2', 'm3']).toContain(from);
      expect(['m1', 'm2', 'm3']).toContain(to);
    }
  });
});
