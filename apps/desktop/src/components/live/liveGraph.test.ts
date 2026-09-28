import type { TaskListItem } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { childrenByParent } from '../flightplan/flightScope';
import { byId, progress, task } from './fixtures.test-helper';
import {
  type LiveBandActivity,
  type LiveBandSpec,
  LOOSE_BAND,
  orderLiveBands,
  readyContainers,
  selectLiveBands,
} from './liveGraph';

// Storefront (a project) holds milestones M1 and M2; Payments (a project) holds M3 and one
// direct task; M3 holds a parent issue with a sub-issue. Plus three tasks with no parent.
const TASKS: TaskListItem[] = [
  task('p-store', { kind: 'project', title: 'Storefront' }),
  task('m-1', { kind: 'milestone', parent: 'p-store', title: 'M1' }),
  task('m-2', { kind: 'milestone', parent: 'p-store', title: 'M2' }),
  task('a-1', { parent: 'm-1', status: 'landed' }),
  task('a-2', { parent: 'm-1', blockedBy: ['a-1'] }),
  task('b-1', { parent: 'm-2', status: 'working' }),
  task('b-2', { parent: 'm-2' }),
  task('p-pay', { kind: 'project', title: 'Payments' }),
  task('m-3', { kind: 'milestone', parent: 'p-pay', title: 'M3' }),
  task('c-1', { parent: 'm-3', status: 'review' }),
  task('c-2', { parent: 'm-3' }),
  task('pi', { parent: 'm-3', title: 'Parent issue' }),
  task('s-1', { parent: 'pi', status: 'working' }),
  task('q-1', { parent: 'p-pay', status: 'working' }),
  task('l-1', { status: 'working' }),
  task('l-2', { status: 'review' }),
  task('l-3', { status: 'review' }),
];

function select(
  opts: {
    sessions?: Parameters<typeof selectLiveBands>[0]['sessions'];
    flying?: string[];
    landing?: string[];
    review?: string[];
  } = {}
) {
  return selectLiveBands({
    taskById: byId(TASKS),
    children: childrenByParent(TASKS),
    sessions: opts.sessions ?? [],
    flying: new Set(opts.flying ?? []),
    landing: new Map((opts.landing ?? []).map((id) => [id, 'queued'])),
    reviewPending: new Set(opts.review ?? []),
  });
}

const summary = (bands: LiveBandSpec[]) =>
  bands.map((b) => ({
    key: b.key,
    kind: b.kind,
    nodes: b.scope.nodes.map((t) => t.meta.id),
  }));

describe('selectLiveBands', () => {
  test('a live fan-out draws its container’s whole plan; a nested one folds into it', () => {
    const bands = select({
      sessions: [
        progress('p-store', 'active'),
        // Under Storefront's plan-wide fan-out: already drawn as its milestone band.
        progress('m-1', 'active'),
      ],
      flying: ['b-1'],
    });
    expect(summary(bands)).toEqual([
      { key: 'p-store', kind: 'fanout', nodes: ['a-1', 'a-2', 'b-1', 'b-2'] },
    ]);
    expect(bands[0]?.scope.bands?.map((b) => b.key)).toEqual(['m-1', 'm-2']);
  });

  test('a session from before plan-wide fan-outs does not swallow a milestone’s own', () => {
    const bands = select({
      sessions: [
        progress('p-store', 'active', { scope: 'direct' }),
        progress('m-1', 'paused'),
      ],
    });
    expect(bands.map((b) => b.key).sort()).toEqual(['m-1', 'p-store']);
  });

  test('with a milestone fan-out under it, an older project fan-out draws only its direct work', () => {
    // The two cover different work on the server, so both run at once.
    const tasks = [
      task('p', { kind: 'project', title: 'Storefront' }),
      task('p-own', { parent: 'p' }),
      task('m', { kind: 'milestone', parent: 'p', title: 'Cart' }),
      task('a', { parent: 'm', status: 'working' }),
      task('b', { parent: 'm' }),
    ];
    const bands = selectLiveBands({
      taskById: byId(tasks),
      children: childrenByParent(tasks),
      sessions: [
        progress('p', 'active', { scope: 'direct' }),
        progress('m', 'active'),
      ],
      flying: new Set(['a']),
      landing: new Map(),
      reviewPending: new Set(),
    });
    expect(summary(bands)).toEqual([
      { key: 'p', kind: 'fanout', nodes: ['p-own'] },
      { key: 'm', kind: 'fanout', nodes: ['a', 'b'] },
    ]);
  });

  test('work in motion brings in its parent container; a project draws its direct work only', () => {
    const bands = select({
      flying: ['s-1', 'q-1'],
      review: ['c-1'],
    });
    expect(summary(bands)).toEqual([
      // c-1 waits on a review: M3's plan, the parent issue as one node.
      { key: 'm-3', kind: 'activity', nodes: ['c-1', 'c-2', 'pi'] },
      // q-1 runs directly under Payments: its direct work, not M3's.
      { key: 'p-pay', kind: 'activity', nodes: ['q-1'] },
      // s-1 runs under the parent issue: its own plan.
      { key: 'pi', kind: 'activity', nodes: ['s-1'] },
    ]);
  });

  test('running and landing work with no container is Loose work; a review is not', () => {
    const bands = select({
      flying: ['l-1'],
      landing: ['l-2'],
      review: ['l-3'],
    });
    expect(summary(bands)).toEqual([
      { key: LOOSE_BAND, kind: 'loose', nodes: ['l-1', 'l-2'] },
    ]);
    expect(bands[0]?.container).toBeNull();
  });

  test('each task sits in one band only', () => {
    const bands = select({
      sessions: [progress('p-store', 'active')],
      flying: ['b-1', 's-1', 'l-1', 'q-1'],
      landing: ['a-2'],
      review: ['c-1'],
    });
    const ids = bands.flatMap((b) => b.scope.nodes.map((t) => t.meta.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(bands.map((b) => b.key)).toEqual([
      'p-store',
      'm-3',
      'p-pay',
      'pi',
      LOOSE_BAND,
    ]);
  });

  test('nothing moving draws nothing', () => {
    expect(select()).toEqual([]);
  });

  test('a fan-out on a container no longer in the list draws no band', () => {
    expect(select({ sessions: [progress('gone', 'active')] })).toEqual([]);
  });
});

function spec(
  key: string,
  kind: LiveBandSpec['kind'] = 'fanout',
  title = key
): LiveBandSpec {
  return {
    key,
    kind,
    container: kind === 'loose' ? null : task(key, { title }),
    progress: null,
    scope: { nodes: [], bands: null, bandOf: new Map() },
  };
}

function entry(
  key: string,
  activity: Partial<LiveBandActivity>,
  kind: LiveBandSpec['kind'] = 'fanout'
) {
  return {
    spec: spec(key, kind),
    activity: { running: 0, queued: 0, session: null, ...activity },
  };
}

describe('orderLiveBands', () => {
  test('running first, then active fan-outs by queue, then paused, then the rest', () => {
    const ordered = orderLiveBands([
      entry('landing-only', {}, 'activity'),
      entry('paused', { session: 'paused', queued: 4 }),
      entry('idle-active', { session: 'active' }),
      entry('queued', { session: 'active', queued: 3 }),
      entry('loose', { running: 2 }, 'loose'),
      entry('running-b', { running: 1, session: 'active' }),
      entry('running-a', { running: 5 }, 'activity'),
    ]);
    expect(ordered.map((b) => b.spec.key)).toEqual([
      // Running: fan-outs, then activity, then Loose work — steady while counts tick.
      'running-b',
      'running-a',
      'loose',
      'queued',
      'idle-active',
      'paused',
      'landing-only',
    ]);
  });

  test('a tier orders by title, so a count changing never shuffles it', () => {
    const ordered = orderLiveBands([
      { ...entry('x', { running: 9 }), spec: spec('x', 'fanout', 'Zeta') },
      { ...entry('y', { running: 1 }), spec: spec('y', 'fanout', 'Alpha') },
    ]);
    expect(ordered.map((b) => b.spec.key)).toEqual(['y', 'x']);
  });
});

describe('readyContainers', () => {
  const tasks: TaskListItem[] = [
    task('p', { kind: 'project' }),
    task('m-a', { kind: 'milestone', parent: 'p', title: 'Alpha' }),
    task('m-b', { kind: 'milestone', parent: 'p', title: 'Beta' }),
    task('m-live', { kind: 'milestone', parent: 'p', title: 'Live' }),
    task('a-1', { parent: 'm-a' }),
    task('a-2', { parent: 'm-a', status: 'landed' }),
    task('b-1', { parent: 'm-b' }),
    task('b-2', { parent: 'm-b' }),
    task('b-3', { parent: 'm-b', assignee: 'human:maya' }),
    task('v-1', { parent: 'm-live' }),
    task('p-1', { parent: 'p' }),
  ];
  const read = (limit = 5) =>
    readyContainers({
      taskById: byId(tasks),
      children: childrenByParent(tasks),
      readyIds: new Set(['a-1', 'b-1', 'b-2', 'b-3', 'v-1', 'p-1']),
      holderOf: (t) =>
        t.meta.assignee.startsWith('human:') ? t.meta.assignee : null,
      liveIds: new Set(['m-live']),
      limit,
    });

  test('milestones with the most work a fan-out would start, teammates’ left out', () => {
    expect(read().map((r) => [r.container.meta.id, r.ready, r.total])).toEqual([
      ['m-b', 2, 3],
      ['m-a', 1, 2],
    ]);
  });

  test('stops at the limit', () => {
    expect(read(1).map((r) => r.container.meta.id)).toEqual(['m-b']);
  });

  test('leaves out what only a person starts: critical risk, a task derived from a review', () => {
    const held = [
      task('m-rel', { kind: 'milestone', title: 'Release' }),
      task('r-1', { parent: 'm-rel', risk: 'critical' }),
      task('r-2', { parent: 'm-rel', derivedFrom: 't-0' }),
      task('r-3', { parent: 'm-rel' }),
      task('m-crit', { kind: 'milestone', title: 'Switchover' }),
      task('c-1', { parent: 'm-crit', risk: 'critical' }),
    ];
    const offered = readyContainers({
      taskById: byId(held),
      children: childrenByParent(held),
      readyIds: new Set(['r-1', 'r-2', 'r-3', 'c-1']),
      holderOf: () => null,
      liveIds: new Set(),
      limit: 5,
    });
    expect(offered.map((r) => [r.container.meta.id, r.ready, r.total])).toEqual(
      [['m-rel', 1, 3]]
    );
  });
});
