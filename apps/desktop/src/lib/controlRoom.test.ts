import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';

import type { BuildFeedInput } from './controlRoom';
import { buildFeed, FEED_GROUPS, groupCap } from './controlRoom';
import type { FeedState } from './feedState';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function task(
  id: string,
  title: string,
  parent: string | null = null
): TaskDoc {
  return {
    meta: { id, title, parent, status: 'todo', kind: 'task' },
  } as TaskDoc;
}

function input(over: Partial<BuildFeedInput> = {}): BuildFeedInput {
  return {
    runs: [],
    tasks: [],
    epics: [],
    readyIds: new Set(),
    blockedIds: new Set(),
    mergeQueue: null,
    pendingApprovals: new Map(),
    openQuestions: new Map(),
    query: '',
    activeStates: new Set(),
    collapsed: new Set(),
    expanded: new Set(),
    ...over,
  };
}

/** Many distinct runs in one state, for exercising the caps. */
function runsInState(n: number, over: Partial<RunMeta>): RunMeta[] {
  return Array.from({ length: n }, (_, i) =>
    run({ id: `r-${i}`, taskId: `t-${i}`, taskTitle: `Task ${i}`, ...over })
  );
}

describe('grouping', () => {
  test('groups render in the fixed priority order, urgent first', () => {
    const model = buildFeed(
      input({
        runs: [
          run({ id: 'r-a', state: 'finished' }),
          run({ id: 'r-b', state: 'running' }),
          run({ id: 'r-c', state: 'awaiting-approval' }),
        ],
      })
    );
    expect(model.groups.map((g) => g.state)).toEqual([
      'waiting',
      'working',
      'review',
    ]);
  });

  test('empty groups are omitted rather than rendering a bare header', () => {
    const model = buildFeed(input({ runs: [run({ state: 'running' })] }));
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.state).toBe('working');
  });

  test('reviewed runs are not in the feed at all', () => {
    const model = buildFeed(
      input({
        runs: [run({ state: 'finished', reviewedAt: '2026-07-26T01:00:00Z' })],
      })
    );
    expect(model.groups).toHaveLength(0);
    expect(model.total).toBe(0);
  });
});

describe('caps and show-more', () => {
  test('working caps at 7 and reports the remainder', () => {
    const model = buildFeed(
      input({ runs: runsInState(10, { state: 'running' }) })
    );
    const group = model.groups[0];
    expect(group?.rows).toHaveLength(7);
    expect(group?.hidden).toBe(3);
    expect(group?.total).toBe(10);
  });

  test('other groups cap at 5', () => {
    const model = buildFeed(
      input({ runs: runsInState(9, { state: 'finished' }) })
    );
    expect(model.groups[0]?.rows).toHaveLength(5);
    expect(model.groups[0]?.hidden).toBe(4);
  });

  test('expanding a group shows everything and clears the remainder', () => {
    const model = buildFeed(
      input({
        runs: runsInState(10, { state: 'running' }),
        expanded: new Set<FeedState>(['working']),
      })
    );
    expect(model.groups[0]?.rows).toHaveLength(10);
    expect(model.groups[0]?.hidden).toBe(0);
  });

  // A capped group must never quietly drop rows: the count the header shows is the real one,
  // and the difference is always reachable.
  test('a capped group still reports its true total', () => {
    const model = buildFeed(
      input({ runs: runsInState(10, { state: 'running' }) })
    );
    const group = model.groups[0];
    expect((group?.rows.length ?? 0) + (group?.hidden ?? 0)).toBe(group?.total);
  });

  test('collapsing hides the rows but keeps the count', () => {
    const model = buildFeed(
      input({
        runs: runsInState(4, { state: 'running' }),
        collapsed: new Set<FeedState>(['working']),
      })
    );
    expect(model.groups[0]?.rows).toHaveLength(0);
    expect(model.groups[0]?.total).toBe(4);
    expect(model.groups[0]?.hidden).toBe(0);
    expect(model.shown).toBe(0);
  });
});

describe('filtering', () => {
  const runs = [
    run({ id: 'r-a', taskId: 't-aaa111', taskTitle: 'Fix the worktree pool' }),
    run({ id: 'r-b', taskId: 't-bbb222', taskTitle: 'Stream agent stdout' }),
  ];
  const tasks = [
    task('t-aaa111', 'Fix the worktree pool', 'e-1'),
    task('t-bbb222', 'Stream agent stdout', 'e-2'),
  ];
  const epics = [task('e-1', 'Runtime'), task('e-2', 'Ship v0.1')];

  test('matches on title', () => {
    const model = buildFeed(input({ runs, tasks, epics, query: 'worktree' }));
    expect(model.groups[0]?.rows.map((r) => r.taskId)).toEqual(['t-aaa111']);
  });

  test('matches on task id', () => {
    const model = buildFeed(input({ runs, tasks, epics, query: 't-bbb222' }));
    expect(model.groups[0]?.rows.map((r) => r.taskId)).toEqual(['t-bbb222']);
  });

  test('matches on epic title', () => {
    const model = buildFeed(input({ runs, tasks, epics, query: 'Runtime' }));
    expect(model.groups[0]?.rows.map((r) => r.taskId)).toEqual(['t-aaa111']);
  });

  test('is case-insensitive and ignores surrounding space', () => {
    const model = buildFeed(
      input({ runs, tasks, epics, query: '  WORKTREE ' })
    );
    expect(model.groups[0]?.rows).toHaveLength(1);
  });

  // Empty means "no filter", not "match nothing" — the difference between a usable default and
  // a screen that starts blank.
  test('no chips selected shows everything', () => {
    const model = buildFeed(
      input({
        runs: [
          run({ id: 'r-a', state: 'running' }),
          run({ id: 'r-b', state: 'finished' }),
        ],
        activeStates: new Set(),
      })
    );
    expect(model.shown).toBe(2);
  });

  test('chips combine as OR', () => {
    const model = buildFeed(
      input({
        runs: [
          run({ id: 'r-a', state: 'running' }),
          run({ id: 'r-b', state: 'finished' }),
          run({ id: 'r-c', state: 'awaiting-approval' }),
        ],
        activeStates: new Set<FeedState>(['working', 'review']),
      })
    );
    expect(model.groups.map((g) => g.state)).toEqual(['working', 'review']);
    expect(model.shown).toBe(2);
  });
});

describe('counts', () => {
  test('shown counts only rendered rows; total ignores filtering', () => {
    const model = buildFeed(
      input({
        runs: runsInState(10, { state: 'running' }),
        query: 'Task 1',
      })
    );
    // "Task 1" matches Task 1 only — the total still reports all ten.
    expect(model.total).toBe(10);
    expect(model.shown).toBe(1);
  });

  // The ribbon has to keep reporting the truth while a chip is filtering the feed, or two
  // numbers on the same screen contradict each other.
  test('ribbon counts are unaffected by the active filter', () => {
    const runs = [
      run({ id: 'r-a', state: 'running' }),
      run({ id: 'r-b', state: 'finished' }),
    ];
    const unfiltered = buildFeed(input({ runs }));
    const filtered = buildFeed(
      input({ runs, activeStates: new Set<FeedState>(['working']) })
    );
    expect(filtered.counts).toEqual(unfiltered.counts);
    expect(filtered.counts.working).toBe(1);
    expect(filtered.counts.review).toBe(1);
  });

  test('ready and blocked counts come from the task sets, not from runs', () => {
    const model = buildFeed(
      input({
        readyIds: new Set(['t-1', 't-2', 't-3']),
        blockedIds: new Set(['t-4']),
      })
    );
    expect(model.counts.ready).toBe(3);
    expect(model.counts.blocked).toBe(1);
  });
});

describe('row content', () => {
  test('a waiting row names the tool it is blocked on', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'awaiting-approval' })],
        pendingApprovals: new Map([['r-a', { toolName: 'Bash' }]]),
      })
    );
    expect(model.groups[0]?.rows[0]?.attention).toEqual({
      reason: 'Wants to run Bash',
      detail: null,
    });
    expect(model.groups[0]?.rows[0]?.waitingOn).toBe('approval');
  });

  test('a running run with an open question moves to waiting and quotes it', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'running' })],
        openQuestions: new Map([['r-a', { question: 'Which database?' }]]),
      })
    );
    const row = model.groups[0]?.rows[0];
    expect(row?.state).toBe('waiting');
    expect(row?.waitingOn).toBe('question');
    expect(row?.attention).toEqual({
      reason: 'Asked you a question',
      detail: 'Which database?',
    });
    expect(model.counts.waiting).toBe(1);
    expect(model.counts.working).toBe(0);
  });

  test('an open question on a finished run does not drag it back to waiting', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'finished' })],
        openQuestions: new Map([['r-a', { question: 'Which database?' }]]),
      })
    );
    expect(model.groups[0]?.rows[0]?.state).toBe('review');
    expect(model.groups[0]?.rows[0]?.waitingOn).toBeNull();
  });

  // After a reload this window never saw the approval.requested event, so the tool name is
  // genuinely unknown. It has to degrade to a truthful generic rather than guess.
  test('a waiting row with no recorded request still says something true', () => {
    const model = buildFeed(
      input({ runs: [run({ state: 'awaiting-approval' })] })
    );
    expect(model.groups[0]?.rows[0]?.attention?.reason).toBe(
      'Waiting for your approval'
    );
  });

  test('a failed row surfaces the run error', () => {
    const model = buildFeed(
      input({ runs: [run({ state: 'failed', error: 'verify failed: tsc' })] })
    );
    expect(model.groups[0]?.rows[0]?.attention?.reason).toBe(
      'verify failed: tsc'
    );
  });

  test('calm rows carry no attention line', () => {
    const model = buildFeed(input({ runs: [run({ state: 'running' })] }));
    expect(model.groups[0]?.rows[0]?.attention).toBeNull();
  });

  test('a landing row shows the queue phase it is actually on', () => {
    const queue: MergeQueueSnapshot = {
      entries: [
        {
          runId: 'r-a',
          taskId: 't-1',
          taskTitle: 'Do the thing',
          state: 'verifying',
          enqueuedAt: '2026-07-26T00:00:00.000Z',
        },
      ],
      history: [],
    };
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'finished' })],
        mergeQueue: queue,
      })
    );
    expect(model.groups[0]?.state).toBe('landing');
    expect(model.groups[0]?.rows[0]?.activity).toBe('verifying');
  });

  test('rows resolve their epic title through the task parent', () => {
    const model = buildFeed(
      input({
        runs: [run({ taskId: 't-1' })],
        tasks: [task('t-1', 'Do the thing', 'e-1')],
        epics: [task('e-1', 'Runtime')],
      })
    );
    expect(model.groups[0]?.rows[0]?.epicTitle).toBe('Runtime');
  });

  test('a task with no epic renders without one rather than breaking', () => {
    const model = buildFeed(
      input({ runs: [run({ taskId: 't-1' })], tasks: [task('t-1', 'Solo')] })
    );
    expect(model.groups[0]?.rows[0]?.epicTitle).toBeNull();
  });
});

describe('group configuration', () => {
  test('only run-backed states are fed; ready and blocked are ribbon-only', () => {
    expect(FEED_GROUPS).toEqual([
      'waiting',
      'failed',
      'working',
      'review',
      'landing',
    ]);
  });

  test('working gets more room than the rest', () => {
    expect(groupCap('working')).toBe(7);
    expect(groupCap('review')).toBe(5);
  });
});
