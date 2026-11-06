import type { TaskListItem } from '@dispatch-foo/core/browser';
import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import type { MilestoneProgress } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { childrenByParent, flightScope } from '../flightplan/flightScope';
import { byId, progress, task } from './fixtures.test-helper';
import {
  buildLiveBand,
  type LiveGeometryCache,
  type LiveShared,
  liveTotals,
} from './liveBandModel';
import { type LiveBandSpec, LOOSE_BAND } from './liveGraph';

// Milestone m: a, b landed (wave 1), c landed after a (wave 2), then d (ready) and e (an
// agent on it) after c (wave 3), f after d (wave 4). g waits on h, which is Maya's.
function milestone(
  overrides: Partial<Record<string, Partial<TaskListItem['meta']>>> = {}
): TaskListItem[] {
  const base = [
    task('m', { kind: 'milestone', title: 'Checkout' }),
    task('t-a', { parent: 'm', status: 'landed' }),
    task('t-b', { parent: 'm', status: 'landed' }),
    task('t-c', { parent: 'm', status: 'landed', blockedBy: ['t-a'] }),
    task('t-d', { parent: 'm', blockedBy: ['t-c'] }),
    task('t-e', { parent: 'm', status: 'working', blockedBy: ['t-c'] }),
    task('t-f', { parent: 'm', blockedBy: ['t-d'] }),
    task('t-g', { parent: 'm', blockedBy: ['t-h'] }),
    task('t-h', { parent: 'm', assignee: 'human:maya' }),
  ];
  return base.map((t) => ({
    ...t,
    meta: { ...t.meta, ...overrides[t.meta.id] },
  }));
}

function shared(
  tasks: TaskListItem[],
  opts: {
    flying?: string[];
    sessions?: MilestoneProgress[];
    landing?: string[];
  } = {}
): LiveShared {
  const children = childrenByParent(tasks);
  return {
    model: DEFAULT_STATUS_MODEL,
    taskById: byId(tasks),
    containerIds: new Set(children.keys()),
    flying: new Set(opts.flying ?? ['t-e']),
    me: 'human:wyat',
    local: 'human:wyat',
    sessions: new Map((opts.sessions ?? []).map((p) => [p.milestoneId, p])),
    withRunBranch: new Set(),
    withFinishedRun: new Set(),
    landing: new Map((opts.landing ?? []).map((id) => [id, 'queued'])),
  };
}

function specOf(
  tasks: TaskListItem[],
  session: MilestoneProgress | null = null
): LiveBandSpec {
  const container = byId(tasks).get('m');
  if (container === undefined) throw new Error('no container');
  return {
    key: 'm',
    kind: session === null ? 'activity' : 'fanout',
    container,
    progress: session,
    scope: flightScope(container, childrenByParent(tasks)),
  };
}

describe('buildLiveBand', () => {
  test('tallies running, queued under an active fan-out, teammates and landing', () => {
    const tasks = milestone();
    const session = progress('m', 'active', { concurrency: 3 });
    const band = buildLiveBand(
      specOf(tasks, session),
      shared(tasks, { sessions: [session], landing: ['t-b'] })
    );
    expect(band.stats).toEqual({
      running: 1,
      // d is ready and the fan-out is filling slots.
      queued: 1,
      teammate: 1,
      // g waits on Maya's h.
      waitingOnTeammate: 1,
      landing: 1,
      done: 3,
      total: 8,
      slots: { used: 1, total: 3 },
    });
    expect(band.activity).toEqual({
      running: 1,
      queued: 1,
      session: 'active',
    });
  });

  test('in a teammate’s fan-out, waiting on teammates reads against this window', () => {
    // Maya started it: her h is hers to start, mine is not, Sam's is nobody's.
    const waiting = (assignee: string) => {
      const tasks = milestone({ 't-h': { assignee } });
      const session = progress('m', 'active', { startedBy: 'human:maya' });
      return buildLiveBand(
        specOf(tasks, session),
        shared(tasks, { sessions: [session] })
      ).stats.waitingOnTeammate;
    };
    expect(
      ['human:maya', 'human:wyat', 'human:sam'].map((a) => waiting(a))
    ).toEqual([0, 0, 1]);
  });

  test('a paused fan-out queues nothing', () => {
    const tasks = milestone();
    const session = progress('m', 'paused');
    const band = buildLiveBand(
      specOf(tasks, session),
      shared(tasks, { sessions: [session] })
    );
    expect(band.stats.queued).toBe(0);
    expect(band.activity.session).toBe('paused');
  });

  test('keeps the waves across a status change, and works them out again for a new blocker', () => {
    const cache: LiveGeometryCache = new Map();
    const before = milestone();
    buildLiveBand(specOf(before), shared(before), { cache });
    const first = cache.get('m')?.waves;
    const moved = milestone({ 't-d': { status: 'working' } });
    const second = buildLiveBand(
      specOf(moved),
      shared(moved, { flying: ['t-e', 't-d'] }),
      { cache }
    );
    expect(cache.get('m')?.waves).toBe(first);
    expect(second.plan.nodes.find((n) => n.task.meta.id === 't-d')?.state).toBe(
      'running'
    );
    const rewired = milestone({ 't-f': { blockedBy: ['t-e'] } });
    buildLiveBand(specOf(rewired), shared(rewired), { cache });
    expect(cache.get('m')?.waves).not.toBe(first);
  });

  test('Loose work has no waves', () => {
    const loose = ['l-1', 'l-2', 'l-3', 'l-4', 'l-5'].map((id) =>
      task(id, { status: 'working' })
    );
    const band = buildLiveBand(
      {
        key: LOOSE_BAND,
        kind: 'loose',
        container: null,
        progress: null,
        scope: { nodes: loose, bands: null, bandOf: new Map() },
      },
      shared(loose, { flying: loose.map((t) => t.meta.id) })
    );
    expect(band.showWaves).toBe(false);
    expect(band.stats.running).toBe(5);
  });
});

describe('liveTotals', () => {
  test('adds the bands up against every live fan-out’s slots', () => {
    const tasks = milestone();
    const active = progress('m', 'active', { concurrency: 3 });
    const band = buildLiveBand(
      specOf(tasks, active),
      shared(tasks, { sessions: [active], landing: ['t-b'] })
    );
    expect(
      liveTotals(
        [band, band],
        [active, progress('x', 'paused', { concurrency: 2 })]
      )
    ).toEqual({
      slots: { used: 2, total: 5 },
      running: 2,
      queued: 2,
      waitingOnTeammate: 2,
      landing: 2,
    });
  });
});
