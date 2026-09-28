import type { RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { DEFAULT_STATUS_MODEL, fanoutScope } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { buildFlightPlan, tasksWithRunBranch } from './flightPlan';
import { childrenByParent, flightScope } from './flightScope';
import { queuePositions } from './flightViews';

function child(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: id,
      status: 'ready',
      kind: 'task',
      parent: 'e-1',
      blockedBy: [],
      assignee: 'none',
      created: `2026-09-01T00:00:0${id.slice(-1)}.000Z`,
      ...overrides,
    },
  } as TaskListItem;
}

const opts = (live: string[] = [], concurrency: number | null = 3) => ({
  liveTaskIds: new Set(live),
  model: DEFAULT_STATUS_MODEL,
  concurrency,
});

// a, b → c → d: three waves.
const CHAIN = [
  child('t-a', { status: 'landed' }),
  child('t-b', { status: 'working' }),
  child('t-c', { blockedBy: ['t-a', 't-b'] }),
  child('t-d', { blockedBy: ['t-c'] }),
];

describe('buildFlightPlan', () => {
  test('layers children into waves along their blockers', () => {
    const plan = buildFlightPlan(CHAIN, opts(['t-b']));
    expect(plan.nodes.map((n) => [n.task.meta.id, n.wave])).toEqual([
      ['t-a', 0],
      ['t-b', 0],
      ['t-c', 1],
      ['t-d', 2],
    ]);
    expect(plan.waves).toEqual([
      { index: 0, total: 2, done: 1, running: 1 },
      { index: 1, total: 1, done: 0, running: 0 },
      { index: 2, total: 1, done: 0, running: 0 },
    ]);
    expect(plan.currentWave).toBe(0);
  });

  test('names each child’s state and what it waits on', () => {
    const plan = buildFlightPlan(
      [
        ...CHAIN,
        child('t-e'),
        child('t-f', { status: 'working', assignee: 'human:maya' }),
      ],
      opts(['t-b'])
    );
    const state = Object.fromEntries(
      plan.nodes.map((n) => [n.task.meta.id, n.state])
    );
    expect(state).toEqual({
      't-a': 'done',
      't-b': 'running',
      't-c': 'blocked',
      't-d': 'blocked',
      't-e': 'queued',
      't-f': 'teammate',
    });
    expect(plan.nodes.find((n) => n.task.meta.id === 't-c')?.waitingOn).toEqual(
      ['t-b']
    );
    expect(plan).toMatchObject({ total: 6, done: 1, running: 1, queued: 1 });
  });

  test('counts slots against the session’s concurrency', () => {
    expect(buildFlightPlan(CHAIN, opts(['t-b'], 3)).slots).toEqual({
      used: 1,
      total: 3,
    });
    expect(buildFlightPlan(CHAIN, opts([], null)).slots).toEqual({
      used: 0,
      total: null,
    });
  });

  test('a finished plan has no current wave; children with no edges are one wave', () => {
    const done = buildFlightPlan(
      [child('t-a', { status: 'landed' }), child('t-b', { status: 'dropped' })],
      opts()
    );
    expect(done.waves).toHaveLength(1);
    expect(done.currentWave).toBeNull();
  });

  test('a blocker outside the container never holds a wave', () => {
    const plan = buildFlightPlan(
      [child('t-a', { blockedBy: ['t-elsewhere'] })],
      opts()
    );
    expect(plan.nodes[0]).toMatchObject({
      wave: 0,
      state: 'queued',
      waitingOn: [],
    });
  });

  test('an unfinished blocker outside the plan still holds its dependent, never its wave', () => {
    const outside = new Map([
      ['t-x', child('t-x', { parent: 'e-9', status: 'working' })],
      ['t-y', child('t-y', { parent: 'e-9', status: 'landed' })],
    ]);
    const plan = buildFlightPlan(
      [
        child('t-a', { blockedBy: ['t-x'] }),
        child('t-b', { blockedBy: ['t-y'] }),
      ],
      { ...opts(), lookup: (id) => outside.get(id) }
    );
    expect(plan.nodes.map((n) => [n.state, n.wave, n.waitingOn])).toEqual([
      ['blocked', 0, ['t-x']],
      ['queued', 0, []],
    ]);
  });

  test('a derived task never reads as queued (the server never dispatches one)', () => {
    const plan = buildFlightPlan(
      [child('t-a', { derivedFrom: 'github-pr:7' })],
      opts()
    );
    expect(plan.nodes[0]?.state).toBe('blocked');
    expect(plan.queued).toBe(0);
  });

  test('a blocker in review no longer holds its dependent (the server stacks it)', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { status: 'review' }),
        child('t-b', { blockedBy: ['t-a'] }),
      ],
      { ...opts(), withRunBranch: new Set(['t-a']) }
    );
    expect(plan.nodes.map((n) => [n.task.meta.id, n.state])).toEqual([
      ['t-a', 'review'],
      ['t-b', 'queued'],
    ]);
    expect(plan.nodes[1]?.waitingOn).toEqual([]);
  });

  test('a blocker in review with no run branch, or a teammate’s, holds until done', () => {
    const plan = buildFlightPlan(
      [
        // Moved to review by hand: nothing to stack on.
        child('t-a', { status: 'review' }),
        child('t-b', { blockedBy: ['t-a'] }),
        // Sam's In Review, even with a branch on this daemon.
        child('t-c', { status: 'review', assignee: 'human:sam' }),
        child('t-d', { blockedBy: ['t-c'] }),
      ],
      { ...opts(), me: 'human:wyat', withRunBranch: new Set(['t-c']) }
    );
    expect(plan.nodes.map((n) => n.state)).toEqual([
      'review',
      'blocked',
      'teammate',
      'blocked',
    ]);
    expect(plan.nodes[1]?.waitingOn).toEqual(['t-a']);
    expect(plan.nodes[3]?.waitingOn).toEqual(['t-c']);
  });

  test('marks the tasks whose last terminal run is still unreviewed as branched', () => {
    const run = (taskId: string, state: string, reviewedAt?: string) =>
      ({ taskId, state, reviewedAt }) as RunMeta;
    expect(
      tasksWithRunBranch([
        run('t-a', 'finished'),
        run('t-b', 'finished', '2026-09-24T00:00:00Z'),
        run('t-c', 'running'),
        run('t-d', 'failed'),
      ])
    ).toEqual(new Set(['t-a', 't-d']));
  });

  test('critical work, a sub-plan and a backlog child never read as queued', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { risk: 'critical' }),
        child('t-b'),
        child('t-c', { status: 'draft' }),
      ],
      { ...opts(), containerIds: new Set(['t-b']) }
    );
    expect(plan.nodes.map((n) => [n.state, n.subPlan])).toEqual([
      ['blocked', false],
      ['blocked', true],
      ['blocked', false],
    ]);
    expect(plan.queued).toBe(0);
  });

  test('uses the waves it is handed instead of recomputing them', () => {
    const plan = buildFlightPlan(CHAIN, {
      ...opts(),
      waves: new Map([
        ['t-a', 3],
        ['t-b', 3],
        ['t-c', 4],
        ['t-d', 5],
      ]),
    });
    expect(plan.nodes.map((n) => n.wave)).toEqual([3, 3, 4, 5]);
  });
});

describe('teammates in the plan', () => {
  const stateById = (plan: ReturnType<typeof buildFlightPlan>) =>
    Object.fromEntries(plan.nodes.map((n) => [n.task.meta.id, n.state]));

  test('another person’s node is theirs in every unfinished state', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { assignee: 'human:sam' }),
        child('t-b', { assignee: 'human:sam', status: 'draft' }),
        child('t-c', { assignee: 'human:sam', status: 'review' }),
        child('t-d', { assignee: 'human:sam', status: 'landed' }),
        child('t-e', { assignee: 'human:sam' }),
        child('t-f', { assignee: 'human:wyat' }),
        child('t-g', { assignee: 'human' }),
        child('t-h', { assignee: 'agent:sam/claude' }),
        child('t-i', { assignee: 'agent' }),
      ],
      { ...opts(['t-e']), me: 'human:wyat' }
    );
    expect(stateById(plan)).toEqual({
      't-a': 'teammate',
      't-b': 'teammate',
      't-c': 'teammate',
      't-d': 'done',
      't-e': 'running',
      't-f': 'queued',
      't-g': 'queued',
      't-h': 'teammate',
      't-i': 'queued',
    });
    expect(plan.nodes.find((n) => n.task.meta.id === 't-h')?.holder).toBe(
      'human:sam'
    );
    expect(plan.queued).toBe(3);
  });

  test('a teammate’s node still holds its dependents until it is satisfied', () => {
    const samTask = child('t-a', { assignee: 'human:sam' });
    const dependent = child('t-b', { blockedBy: ['t-a'] });
    const held = buildFlightPlan([samTask, dependent], {
      ...opts(),
      me: 'human:wyat',
    });
    expect(stateById(held)).toEqual({ 't-a': 'teammate', 't-b': 'blocked' });
    expect(held.nodes[1]?.waitingOn).toEqual(['t-a']);
    const landed = buildFlightPlan(
      [
        { meta: { ...samTask.meta, status: 'landed' } } as TaskListItem,
        dependent,
      ],
      { ...opts(), me: 'human:wyat' }
    );
    expect(stateById(landed)).toEqual({ 't-a': 'done', 't-b': 'queued' });
  });

  test('a live fan-out works for whoever started it, not the viewer', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { assignee: 'human:wyat' }),
        child('t-b', { assignee: 'human:ada' }),
        child('t-c', { assignee: 'human' }),
      ],
      {
        ...opts(),
        me: 'human:wyat',
        ownerOf: () => 'p-1',
        startedByOf: (owner) => (owner === 'p-1' ? 'human:ada' : null),
      }
    );
    expect(stateById(plan)).toEqual({
      't-a': 'teammate',
      't-b': 'queued',
      't-c': 'teammate',
    });
    expect(plan.nodes.every((n) => n.owner === 'p-1')).toBe(true);
  });

  test('bare human is the daemon’s own human, whoever is viewing', () => {
    const bare = [child('t-a', { assignee: 'human' })];
    // Ada's window on the operator's daemon: bare `human` is the operator's.
    const adas = (startedBy: string) =>
      stateById(
        buildFlightPlan(bare, {
          ...opts(),
          me: 'human:ada',
          local: 'human:wyat',
          startedByOf: () => startedBy,
        })
      );
    expect(adas('human:ada')).toEqual({ 't-a': 'teammate' });
    expect(adas('human:wyat')).toEqual({ 't-a': 'queued' });
  });

  test('before the viewer is known, only bare human is theirs', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { assignee: 'human:wyat' }),
        child('t-b', { assignee: 'human' }),
      ],
      opts()
    );
    expect(stateById(plan)).toEqual({ 't-a': 'teammate', 't-b': 'queued' });
  });

  test('queue positions skip a teammate’s node', () => {
    const plan = buildFlightPlan(
      [
        child('t-a', { assignee: 'human:sam', priority: 'urgent' }),
        child('t-b', { priority: 'high' }),
        child('t-c', { priority: 'low' }),
      ],
      { ...opts(), me: 'human:wyat' }
    );
    const queue = queuePositions(plan.nodes, () => 1);
    expect(queue.has('t-a')).toBe(false);
    expect(queue.get('t-b')).toEqual({ position: 0, free: 1 });
    expect(queue.get('t-c')).toEqual({ position: 1, free: 1 });
  });
});

// initiative → project → { milestone → { issue, parent issue → sub-issue }, direct }
test('the plan draws exactly the tasks the server’s fan-out covers', () => {
  const tree = [
    child('i-1', { kind: 'initiative', parent: null }),
    child('p-1', { kind: 'project', parent: 'i-1' }),
    child('m-1', { kind: 'milestone', parent: 'p-1' }),
    child('m-2', { kind: 'milestone', parent: 'p-1' }),
    child('t-1', { parent: 'm-1' }),
    child('t-2', { parent: 'm-1' }),
    child('t-3', { parent: 't-2' }),
    child('t-4', { parent: 'm-2', blockedBy: ['t-1'] }),
    child('t-5', { parent: 'p-1' }),
  ];
  const children = childrenByParent(tree);
  for (const container of tree.slice(0, 4)) {
    const drawn = flightScope(container, children).nodes.map((t) => t.meta.id);
    const covered = fanoutScope(
      container.meta.id,
      (id) => children.get(id) ?? []
    ).map((t) => t.meta.id);
    expect(new Set(drawn)).toEqual(new Set(covered));
  }
  expect(
    new Set(flightScope(tree[1], children).nodes.map((t) => t.meta.id))
  ).toEqual(new Set(['t-1', 't-2', 't-4', 't-5']));
});
