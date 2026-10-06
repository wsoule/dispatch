import type { TaskListItem } from '@dispatch-foo/core/browser';
import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import type {
  EpicProgress,
  MergeQueueEntry,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  buildCockpit,
  type CockpitInput,
  type CockpitItem,
  compareReady,
  formatAge,
  groupByOwner,
  indexCockpitTasks,
  inScope,
  personOf,
} from './cockpit';
import type { TaskAttention } from './taskAttention';

const ME = 'human:wyat';

function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: `Task ${id}`,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-10T00:00:00.000Z',
      external: null,
      selfReview: true,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      estimate: null,
      dueDate: null,
      startDate: null,
      cycle: null,
      relatedTo: [],
      duplicateOf: null,
      initiatives: [],
      creator: null,
      color: null,
      icon: null,
      sortOrder: null,
      ...overrides,
    },
  };
}

function run(
  id: string,
  taskId: string,
  overrides: Partial<RunMeta> = {}
): RunMeta {
  return {
    id,
    taskId,
    taskTitle: `Task ${taskId}`,
    executor: 'claude',
    state: 'running',
    branch: `dispatch/${taskId}`,
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    dispatchedBy: ME,
    ...overrides,
  };
}

function input(
  overrides: Partial<Omit<CockpitInput, 'index'>> & {
    tasks?: TaskListItem[];
  } = {}
): CockpitInput {
  const { tasks = [], ...rest } = overrides;
  return {
    index: indexCockpitTasks(tasks, DEFAULT_STATUS_MODEL),
    runs: [],
    latestRunByTaskId: new Map(),
    attentionByTaskId: new Map(),
    liveEpicSessions: [],
    readinessById: new Map(),
    me: ME,
    local: ME,
    scope: { kind: 'me' },
    pending: new Map(),
    landing: new Map(),
    ...rest,
  };
}

const keys = (items: CockpitItem[]) => items.map((i) => i.key);

describe('personOf', () => {
  test('a named human is themselves; the bare legacy human is me', () => {
    expect(personOf('human:maya', ME)).toBe('human:maya');
    expect(personOf('human', ME)).toBe(ME);
  });
  test('agents and nobody belong to no person', () => {
    expect(personOf('agent', ME)).toBeNull();
    expect(personOf('agent:wyat/claude', ME)).toBeNull();
    expect(personOf('none', ME)).toBeNull();
  });
});

describe('inScope', () => {
  test('me covers my work, and open work only where asked', () => {
    expect(inScope(ME, { kind: 'me' }, ME)).toBe(true);
    expect(inScope('human:maya', { kind: 'me' }, ME)).toBe(false);
    expect(inScope(null, { kind: 'me' }, ME)).toBe(false);
    expect(inScope(null, { kind: 'me' }, ME, true)).toBe(true);
  });
  test('team covers everyone; a person covers only them', () => {
    expect(inScope('human:maya', { kind: 'team' }, ME)).toBe(true);
    expect(
      inScope('human:maya', { kind: 'person', ref: 'human:maya' }, ME)
    ).toBe(true);
    expect(inScope(ME, { kind: 'person', ref: 'human:maya' }, ME)).toBe(false);
  });
});

describe('compareReady', () => {
  test('ranks priority, then due, then cycle, then age', () => {
    const cycle = (n: number, startsAt: string) => ({
      id: `c-${n}`,
      number: n,
      name: null,
      startsAt,
      endsAt: startsAt,
    });
    const tasks = [
      task('t-old', { created: '2026-01-01T00:00:00.000Z' }),
      task('t-new', { created: '2026-09-01T00:00:00.000Z' }),
      task('t-urgent', { priority: 'urgent' }),
      task('t-due-late', { dueDate: '2026-12-01' }),
      task('t-due-soon', { dueDate: '2026-10-01' }),
      task('t-cycle-next', { cycle: cycle(43, '2026-10-01T00:00:00Z') }),
      task('t-cycle-now', { cycle: cycle(42, '2026-09-20T00:00:00Z') }),
      task('t-low', { priority: 'low' }),
    ];
    expect([...tasks].sort(compareReady).map((t) => t.meta.id)).toEqual([
      't-urgent',
      't-due-soon',
      't-due-late',
      't-cycle-now',
      't-cycle-next',
      't-old',
      't-new',
      't-low',
    ]);
  });
});

describe('buildCockpit: Ready for you', () => {
  test('is the unblocked, unstarted queue in scope, ranked', () => {
    const tasks = [
      task('t-mine', { assignee: ME, priority: 'high' }),
      task('t-open', { assignee: 'none', priority: 'urgent' }),
      task('t-agent', { assignee: 'agent' }),
      task('t-maya', { assignee: 'human:maya' }),
      task('t-blocker', { status: 'working', assignee: 'human:maya' }),
      task('t-blocked', { blockedBy: ['t-blocker'] }),
      task('t-draft', { status: 'draft' }),
      task('t-done', { status: 'landed' }),
    ];
    const lanes = buildCockpit(input({ tasks }));
    expect(keys(lanes.ready)).toEqual(['t-open', 't-mine', 't-agent']);
  });

  test('the team scope shows everyone’s ready work', () => {
    const tasks = [
      task('t-mine', { assignee: ME }),
      task('t-maya', { assignee: 'human:maya' }),
    ];
    const lanes = buildCockpit(input({ tasks, scope: { kind: 'team' } }));
    expect(keys(lanes.ready).sort()).toEqual(['t-maya', 't-mine']);
  });

  test('a pending dispatch leaves Ready and starts in flight', () => {
    const tasks = [task('t-1'), task('t-2')];
    const lanes = buildCockpit(
      input({ tasks, pending: new Map([['t-1', 1000]]) })
    );
    expect(keys(lanes.ready)).toEqual(['t-2']);
    expect(lanes.flight[0]).toMatchObject({
      kind: 'starting',
      taskId: 't-1',
      startedAt: 1000,
    });
  });

  test('a pending dispatch whose run is already live shows the run, not a starting row', () => {
    const tasks = [task('t-1', { status: 'working' })];
    const lanes = buildCockpit(
      input({
        tasks,
        runs: [run('r-1', 't-1')],
        pending: new Map([['t-1', 1000]]),
      })
    );
    expect(keys(lanes.flight)).toEqual(['run:r-1']);
  });

  test('a bare-title spec assigned to me goes to Needs you instead', () => {
    const tasks = [task('t-thin', { assignee: ME }), task('t-open-thin')];
    const reading = {
      level: 0 as const,
      label: 'title only',
      confidence: 1,
      splitProbability: 0,
    };
    const lanes = buildCockpit(
      input({
        tasks,
        readinessById: new Map([
          ['t-thin', reading],
          ['t-open-thin', reading],
        ]),
      })
    );
    // Unassigned thin specs stay pickable; mine asks me for words.
    expect(keys(lanes.ready)).toEqual(['t-open-thin']);
    expect(lanes.needs).toEqual([
      expect.objectContaining({ taskId: 't-thin', reason: 'unclear' }),
    ]);
  });
});

describe('buildCockpit: In flight', () => {
  test('lists live runs newest first, with a fan-out’s runs nested under it', () => {
    const epic = task('e-1', { kind: 'milestone', status: 'working' });
    const tasks = [
      epic,
      task('t-a', { parent: 'e-1', status: 'working' }),
      task('t-b', { status: 'working' }),
      task('t-c', { status: 'working' }),
    ];
    const progress = {
      epicId: 'e-1',
      active: true,
      session: null,
      spend: {
        settledUsd: 0,
        liveCount: 1,
        estimatedLiveUsd: 0,
        runsStarted: 1,
        maxSpendUsd: null,
        maxRuns: null,
      },
      children: [
        {
          id: 't-a',
          title: 'a',
          status: 'working',
          phase: 'working',
          wave: 1,
          openFindings: 0,
        },
      ],
      waves: [],
      liveRuns: [],
    } as EpicProgress;
    const runs = [
      run('r-a', 't-a'),
      run('r-b', 't-b', { createdAt: '2026-09-20T01:00:00.000Z' }),
      run('r-c', 't-c', { createdAt: '2026-09-20T02:00:00.000Z' }),
      run('r-old', 't-b', { state: 'finished' }),
    ];
    const lanes = buildCockpit(
      input({ tasks, runs, liveEpicSessions: [progress] })
    );
    expect(keys(lanes.flight)).toEqual([
      'fanout:e-1',
      'run:r-a',
      'run:r-c',
      'run:r-b',
    ]);
    expect(lanes.flight[1]).toMatchObject({ kind: 'run', nested: true });
  });

  test('a teammate’s started task with no run shows in the team scope, not mine', () => {
    const tasks = [
      task('t-maya', { status: 'working', assignee: 'human:maya' }),
    ];
    expect(buildCockpit(input({ tasks })).flight).toEqual([]);
    const team = buildCockpit(input({ tasks, scope: { kind: 'team' } }));
    expect(team.flight).toEqual([
      expect.objectContaining({ kind: 'started', owner: 'human:maya' }),
    ]);
  });

  test('someone else’s run stays out of my scope', () => {
    const tasks = [task('t-1', { status: 'working' })];
    const runs = [run('r-1', 't-1', { dispatchedBy: 'human:maya' })];
    expect(buildCockpit(input({ tasks, runs })).flight).toEqual([]);
    expect(
      keys(
        buildCockpit(
          input({ tasks, runs, scope: { kind: 'person', ref: 'human:maya' } })
        ).flight
      )
    ).toEqual(['run:r-1']);
  });
});

describe('buildCockpit: whose run it is (XH-R9)', () => {
  test('a run is the human it acts for, not who dispatched it', () => {
    const tasks = [task('t-1', { status: 'working' })];
    const runs = [
      run('r-1', 't-1', { dispatchedBy: ME, operator: 'human:maya' }),
    ];
    expect(buildCockpit(input({ tasks, runs })).flight).toEqual([]);
    expect(
      keys(
        buildCockpit(
          input({ tasks, runs, scope: { kind: 'person', ref: 'human:maya' } })
        ).flight
      )
    ).toEqual(['run:r-1']);
  });
});

describe('buildCockpit: whose run it is', () => {
  const unsigned = (id: string, taskId: string) =>
    run(id, taskId, { dispatchedBy: undefined });
  function fanout(startedBy: string | null, childIds: string[]): EpicProgress {
    return {
      epicId: 'e-1',
      active: true,
      session: {
        epicId: 'e-1',
        concurrency: 3,
        executor: 'claude',
        state: 'active',
        maxSpendUsd: null,
        maxRuns: null,
        startedAt: '2026-09-20T00:00:00.000Z',
        startedBy,
        scope: 'plan',
        updatedAt: '2026-09-20T00:00:00.000Z',
        active: true,
      },
      spend: {
        settledUsd: 0,
        liveCount: childIds.length,
        estimatedLiveUsd: 0,
        runsStarted: childIds.length,
        maxSpendUsd: null,
        maxRuns: null,
      },
      children: childIds.map((id) => ({
        id,
        title: id,
        status: 'working',
        phase: 'working',
        wave: 1,
        openFindings: 0,
      })),
      waves: [],
      liveRuns: [],
    };
  }
  const epic = task('e-1', { kind: 'milestone', status: 'working' });
  const tasks = [
    epic,
    task('t-a', { parent: 'e-1', status: 'working' }),
    task('t-loose', { status: 'working' }),
  ];

  test('on a single-user daemon a run nobody signed is mine', () => {
    const lanes = buildCockpit(
      input({ tasks, runs: [unsigned('r-1', 't-loose')] })
    );
    expect(lanes.flight).toEqual([
      expect.objectContaining({ key: 'run:r-1', owner: ME }),
    ]);
  });

  test('an older daemon that names no human keeps a run nobody signed as mine', () => {
    const lanes = buildCockpit(
      input({ tasks, local: null, runs: [unsigned('r-1', 't-loose')] })
    );
    expect(keys(lanes.flight)).toEqual(['run:r-1']);
  });

  test('on a daemon someone else runs, a run nobody signed is nobody’s', () => {
    const base = {
      tasks,
      me: 'human:maya',
      runs: [unsigned('r-1', 't-loose')],
    };
    expect(buildCockpit(input(base)).flight).toEqual([]);
    expect(
      buildCockpit(input({ ...base, scope: { kind: 'team' } })).flight
    ).toEqual([expect.objectContaining({ key: 'run:r-1', owner: null })]);
  });

  test('a teammate’s fan-out, runs and all, stays out of my scope', () => {
    const base = {
      tasks,
      runs: [unsigned('r-a', 't-a')],
      liveEpicSessions: [fanout('human:maya', ['t-a'])],
    };
    expect(buildCockpit(input(base)).flight).toEqual([]);
    expect(
      buildCockpit(
        input({ ...base, scope: { kind: 'person', ref: 'human:maya' } })
      ).flight
    ).toEqual([
      expect.objectContaining({ key: 'fanout:e-1', owner: 'human:maya' }),
      expect.objectContaining({ key: 'run:r-a', owner: 'human:maya' }),
    ]);
  });

  test('my fan-out’s runs are mine; one that names nobody is the daemon human’s', () => {
    const mine = buildCockpit(
      input({
        tasks,
        runs: [unsigned('r-a', 't-a')],
        liveEpicSessions: [fanout(ME, ['t-a'])],
      })
    );
    expect(keys(mine.flight)).toEqual(['fanout:e-1', 'run:r-a']);
    // Seen from a teammate's window, an unnamed session is the daemon's human's, not theirs.
    const teammate = buildCockpit(
      input({
        tasks,
        me: 'human:maya',
        runs: [unsigned('r-a', 't-a')],
        liveEpicSessions: [fanout(null, ['t-a'])],
      })
    );
    expect(teammate.flight).toEqual([]);
  });
});

describe('buildCockpit: landing', () => {
  function queued(
    r: RunMeta,
    state: MergeQueueEntryState = 'verifying'
  ): MergeQueueEntry {
    return {
      runId: r.id,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
      state,
      enqueuedAt: '2026-09-20T01:00:00.000Z',
    };
  }
  const finished = (id: string, taskId: string, by = ME) =>
    run(id, taskId, {
      state: 'finished',
      reviewedAt: '2026-09-20T00:30:00.000Z',
      dispatchedBy: by,
    });

  test('a run the queue is landing sits in flight, in queue order, whoever the task is assigned to', () => {
    const tasks = [
      task('t-agent', { status: 'landing', assignee: 'agent' }),
      task('t-none', { status: 'landing' }),
      task('t-me', { status: 'landing', assignee: ME }),
    ];
    const rAgent = finished('r-agent', 't-agent');
    const rNone = finished('r-none', 't-none');
    const rMe = finished('r-me', 't-me');
    const runs = [rAgent, rNone, rMe];
    const landing = new Map(
      [rMe, rAgent, rNone].map((r) => [r.taskId, queued(r)])
    );
    for (const scope of [{ kind: 'me' }, { kind: 'team' }] as const) {
      const lanes = buildCockpit(
        input({
          tasks,
          runs,
          latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
          landing,
          scope,
        })
      );
      expect(keys(lanes.flight)).toEqual([
        'landing:t-me',
        'landing:t-agent',
        'landing:t-none',
      ]);
      expect(lanes.flight[0]).toEqual(
        expect.objectContaining({ kind: 'landing', owner: ME, run: rMe })
      );
      expect(lanes.needs).toEqual([]);
    }
  });

  test('a held landing waits on me in Needs you, not also in flight', () => {
    const tasks = [task('t-held', { status: 'landing', assignee: 'agent' })];
    const held = finished('r-held', 't-held');
    const runs = [held];
    const lanes = buildCockpit(
      input({
        tasks,
        runs,
        latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
        attentionByTaskId: new Map([['t-held', 'waiting']]),
        landing: new Map([['t-held', queued(held, 'blocked-environment')]]),
      })
    );
    expect(keys(lanes.needs)).toEqual(['needs:t-held']);
    expect(lanes.flight).toEqual([]);
  });

  test('a teammate’s landing run is theirs, not mine', () => {
    const tasks = [task('t-1', { status: 'landing', assignee: 'agent' })];
    const mayas = finished('r-1', 't-1', 'human:maya');
    const base = {
      tasks,
      runs: [mayas],
      latestRunByTaskId: new Map([['t-1', mayas]]),
      landing: new Map([['t-1', queued(mayas)]]),
    };
    expect(buildCockpit(input(base)).flight).toEqual([]);
    expect(
      keys(
        buildCockpit(
          input({ ...base, scope: { kind: 'person', ref: 'human:maya' } })
        ).flight
      )
    ).toEqual(['landing:t-1']);
  });
});

describe('buildCockpit: Needs you', () => {
  test('orders waiting, failed, review, then my review-status tasks, and claims each task once', () => {
    const tasks = [
      task('t-wait', { status: 'working' }),
      task('t-fail', { status: 'working' }),
      task('t-review', { status: 'review' }),
      task('t-in-review', { status: 'review', assignee: ME }),
      task('t-maya-review', { status: 'review', assignee: 'human:maya' }),
    ];
    const runs = [
      run('r-wait', 't-wait', { state: 'awaiting-approval' }),
      run('r-fail', 't-fail', { state: 'failed' }),
      run('r-review', 't-review', { state: 'finished' }),
    ];
    const attention = new Map<string, TaskAttention>([
      ['t-review', 'review'],
      ['t-fail', 'failed'],
      ['t-wait', 'waiting'],
    ]);
    const lanes = buildCockpit(
      input({
        tasks,
        runs,
        attentionByTaskId: attention,
        latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
      })
    );
    expect(
      lanes.needs.map((n) => (n.kind === 'needs' ? n.reason : n.kind))
    ).toEqual(['waiting', 'failed', 'review', 'in-review']);
    // The run waiting on an approval is not also in flight.
    expect(lanes.flight).toEqual([]);
  });
});

describe('groupByOwner', () => {
  test('puts me first, others by name, the unowned last', () => {
    const items = buildCockpit(
      input({
        tasks: [
          task('t-1', { assignee: 'human:zed' }),
          task('t-2', { assignee: 'none' }),
          task('t-3', { assignee: ME }),
          task('t-4', { assignee: 'human:amy' }),
        ],
        scope: { kind: 'team' },
      })
    ).ready;
    const groups = groupByOwner(
      items,
      [
        { ref: 'human:zed', name: 'Zed' },
        { ref: 'human:amy', name: 'Amy' },
        { ref: ME, name: 'Wyat' },
      ],
      ME
    );
    expect(groups.map((g) => g.header?.name)).toEqual([
      'Wyat',
      'Amy',
      'Zed',
      'Agents & unassigned',
    ]);
    expect(groups.map((g) => g.header?.count)).toEqual([1, 1, 1, 1]);
  });
});

test('formatAge reads compactly', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  expect(formatAge('2026-09-23T11:59:40.000Z', now)).toBe('now');
  expect(formatAge('2026-09-23T11:48:00.000Z', now)).toBe('12m');
  expect(formatAge('2026-09-23T08:00:00.000Z', now)).toBe('4h');
  expect(formatAge('2026-07-25T12:00:00.000Z', now)).toBe('60d');
  expect(formatAge('garbage', now)).toBe('—');
});
