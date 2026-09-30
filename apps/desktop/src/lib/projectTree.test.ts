import type { TaskDoc, TaskListItem } from '@dispatch/core/browser';
import { statusModelOf } from '@dispatch/core/browser';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildProjectTree,
  containerHealth,
  expandedByDefault,
  flattenProjectTree,
} from './projectTree';
import { setActiveStatusModel } from './statusModel';

type Meta = TaskDoc['meta'];

function node(
  id: string,
  overrides: Partial<Meta> = {},
  title = id
): TaskListItem {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-09-01T12:00:00.000Z',
      updated: '2026-09-01T12:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      initiatives: [],
      dueDate: null,
      ...overrides,
    },
  } as TaskListItem;
}

afterEach(() => setActiveStatusModel(null));

// Growth (initiative) › Payments (project) › Beta, GA (milestones) › issues; Payments is
// also listed under a second initiative, Platform.
const growth = node('i-1', { kind: 'initiative' }, 'Growth');
const platform = node('i-2', { kind: 'initiative' }, 'Platform');
const payments = node(
  'p-1',
  { kind: 'project', parent: 'i-1', initiatives: ['i-2'] },
  'Payments'
);
const ga = node(
  'm-2',
  { kind: 'milestone', parent: 'p-1', dueDate: '2026-12-01' },
  'GA'
);
const beta = node(
  'm-1',
  { kind: 'milestone', parent: 'p-1', dueDate: '2026-10-01' },
  'Beta'
);
const checkout = node('t-1', { parent: 'm-1', status: 'working' });
const card = node('t-2', { parent: 't-1', status: 'landed' });
const receipt = node('t-3', { parent: 't-1', status: 'dropped' });
const launch = node('t-4', { parent: 'm-2', status: 'landed' });
const urgent = node('t-5', { parent: 'm-2', priority: 'urgent' });
const loose = node('t-9');
const all = [
  growth,
  platform,
  payments,
  ga,
  beta,
  checkout,
  card,
  receipt,
  launch,
  urgent,
  loose,
];

describe('buildProjectTree', () => {
  test('roots are the parentless containers, initiatives first; loose issues are left out', () => {
    const tree = buildProjectTree([payments, loose, growth, platform]);
    expect(tree.roots).toEqual(['i-1', 'i-2']);
    const orphan = buildProjectTree([node('p-9', { kind: 'project' }), loose]);
    expect(orphan.roots).toEqual(['p-9']);
  });

  test('milestones order by target date; issues open first, then by priority', () => {
    const tree = buildProjectTree(all);
    expect(tree.children.get('p-1')).toEqual(['m-1', 'm-2']);
    expect(tree.children.get('m-2')).toEqual(['t-5', 't-4']);
  });

  test('a project under two initiatives is a child of both', () => {
    const tree = buildProjectTree(all);
    expect(tree.children.get('i-1')).toEqual(['p-1']);
    expect(tree.children.get('i-2')).toEqual(['p-1']);
  });

  test('progress counts every issue below, sub-issues included, canceled in neither', () => {
    const tree = buildProjectTree(all, new Set(['t-5']));
    // Beta: t-1 working, t-2 landed, t-3 dropped (not counted).
    expect(tree.rollups.get('m-1')).toEqual({
      done: 1,
      total: 2,
      started: 1,
      attention: 0,
    });
    expect(tree.rollups.get('p-1')).toEqual({
      done: 2,
      total: 4,
      started: 1,
      attention: 1,
    });
    // Both initiatives see the whole project.
    expect(tree.rollups.get('i-2')).toEqual(tree.rollups.get('p-1'));
  });

  test('attention counts open issues only: a landed or dropped one is no risk', () => {
    // Every task whose last run failed or waits in review, whatever its status now.
    const tree = buildProjectTree(all, new Set(['t-2', 't-3', 't-4']));
    expect(tree.rollups.get('m-1')?.attention).toBe(0);
    expect(tree.rollups.get('p-1')?.attention).toBe(0);
    const m1 = tree.rollups.get('m-1');
    if (m1 === undefined) throw new Error('no rollup');
    expect(containerHealth(ga, m1, '2026-09-24')).toBe('on-track');
  });

  test("reads the project's own status types", () => {
    setActiveStatusModel(
      statusModelOf({
        statuses: ['Todo', 'In Progress', 'Done', 'Canceled'],
        statusDefinitions: [
          { name: 'Todo', type: 'unstarted', color: null },
          { name: 'In Progress', type: 'started', color: null },
          { name: 'Done', type: 'completed', color: null },
          { name: 'Canceled', type: 'canceled', color: null },
        ],
      })
    );
    const m = node('m-1', { kind: 'milestone' });
    const tree = buildProjectTree([
      m,
      node('t-1', { parent: 'm-1', status: 'Done' }),
      node('t-2', { parent: 'm-1', status: 'In Progress' }),
      node('t-3', { parent: 'm-1', status: 'Canceled' }),
      node('t-4', { parent: 'm-1', status: 'Todo' }),
    ]);
    expect(tree.rollups.get('m-1')).toEqual({
      done: 1,
      total: 3,
      started: 1,
      attention: 0,
    });
  });

  test('a parent cycle neither loops nor double counts', () => {
    const a = node('m-1', { kind: 'milestone', parent: 't-1' });
    const b = node('t-1', { parent: 'm-1' });
    const tree = buildProjectTree([a, b]);
    expect(tree.roots).toEqual([]);
    expect(tree.rollups.get('m-1')?.total).toBe(1);
  });
});

describe('flattenProjectTree', () => {
  test('initiatives and projects start open; milestones and parent issues folded', () => {
    const tree = buildProjectTree(all);
    const rows = flattenProjectTree(tree, (_key, doc) =>
      expandedByDefault(doc)
    );
    expect(rows.map((r) => [r.key, r.depth, r.expanded])).toEqual([
      ['i-1', 0, true],
      ['i-1/p-1', 1, true],
      ['i-1/p-1/m-1', 2, false],
      ['i-1/p-1/m-2', 2, false],
      ['i-2', 0, true],
      ['i-2/p-1', 1, true],
      ['i-2/p-1/m-1', 2, false],
      ['i-2/p-1/m-2', 2, false],
    ]);
    expect(rows[2]?.parentKey).toBe('i-1/p-1');
  });

  test('opening a milestone and its parent issue reaches the sub-issues', () => {
    const tree = buildProjectTree(all);
    const open = new Set(['i-1/p-1/m-1', 'i-1/p-1/m-1/t-1']);
    const rows = flattenProjectTree(
      tree,
      (key, doc) => expandedByDefault(doc) || open.has(key)
    );
    const keys = rows.map((r) => r.key);
    expect(keys.slice(2, 7)).toEqual([
      'i-1/p-1/m-1',
      'i-1/p-1/m-1/t-1',
      'i-1/p-1/m-1/t-1/t-2',
      'i-1/p-1/m-1/t-1/t-3',
      'i-1/p-1/m-2',
    ]);
    const leaf = rows.find((r) => r.key === 'i-1/p-1/m-1/t-1/t-2');
    expect(leaf).toMatchObject({ depth: 4, expandable: false });
  });

  test('2000 tasks flatten fully open into one row each', () => {
    const tasks: TaskListItem[] = [];
    for (let p = 0; p < 10; p++) {
      tasks.push(node(`p-${p}`, { kind: 'project' }));
      for (let m = 0; m < 5; m++) {
        tasks.push(
          node(`m-${p}-${m}`, { kind: 'milestone', parent: `p-${p}` })
        );
        for (let i = 0; i < 39; i++) {
          tasks.push(node(`t-${p}-${m}-${i}`, { parent: `m-${p}-${m}` }));
        }
      }
    }
    const tree = buildProjectTree(tasks);
    const rows = flattenProjectTree(tree, () => true);
    expect(rows).toHaveLength(tasks.length);
    expect(tree.rollups.get('p-0')?.total).toBe(5 * 39);
  });
});

describe('containerHealth', () => {
  const counts = (over: Partial<Record<string, number>> = {}) => ({
    done: 0,
    total: 4,
    started: 0,
    attention: 0,
    ...over,
  });
  const today = '2026-10-15';

  test('done once every issue closed', () => {
    expect(containerHealth(beta, counts({ done: 4 }), today)).toBe('done');
  });

  test('off track past its target date with open work', () => {
    expect(containerHealth(beta, counts({ started: 1 }), today)).toBe(
      'off-track'
    );
  });

  test('at risk when an issue waits on a human; on track once anything moved', () => {
    expect(containerHealth(ga, counts({ attention: 1 }), today)).toBe(
      'at-risk'
    );
    expect(containerHealth(ga, counts({ started: 1 }), today)).toBe('on-track');
    expect(containerHealth(ga, counts(), today)).toBeNull();
  });
});
