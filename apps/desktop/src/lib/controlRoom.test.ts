import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
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

/**
 * A review/verify agent's run, shaped the way the orchestrator really creates
 * one: branched off the execute run it inspects, so its `baseBranch` is that
 * run's `branch`. That link is what pairs the two.
 */
function auxRun(
  over: Partial<RunMeta> & { kind: 'review' | 'verify' }
): RunMeta {
  return run({
    branch: `dispatch/${over.kind}-t-1-${over.id ?? 'aux'}`,
    baseBranch: 'dispatch/t-1',
    ...over,
  });
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
    fixLoops: new Map(),
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
          run({
            id: 'r-b',
            taskId: 't-2',
            branch: 'dispatch/t-2',
            state: 'running',
          }),
          run({
            id: 'r-c',
            taskId: 't-3',
            branch: 'dispatch/t-3',
            state: 'awaiting-approval',
          }),
        ],
      })
    );
    expect(model.groups.map((g) => g.state)).toEqual([
      'approve',
      'review',
      'working',
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
          run({
            id: 'r-b',
            taskId: 't-2',
            branch: 'dispatch/t-2',
            state: 'finished',
          }),
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
          run({
            id: 'r-b',
            taskId: 't-2',
            branch: 'dispatch/t-2',
            state: 'finished',
          }),
          run({
            id: 'r-c',
            taskId: 't-3',
            branch: 'dispatch/t-3',
            state: 'awaiting-approval',
          }),
        ],
        activeStates: new Set<FeedState>(['working', 'review']),
      })
    );
    expect(model.groups.map((g) => g.state)).toEqual(['review', 'working']);
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
      run({
        id: 'r-b',
        taskId: 't-2',
        branch: 'dispatch/t-2',
        state: 'finished',
      }),
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
    expect(model.groups[0]?.rows[0]?.state).toBe('approve');
  });

  test('a running run with an open question moves to answer and quotes it', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'running' })],
        openQuestions: new Map([['r-a', [{ question: 'Which database?' }]]]),
      })
    );
    const row = model.groups[0]?.rows[0];
    expect(row?.state).toBe('answer');
    expect(row?.attention).toEqual({
      reason: 'Asked you a question',
      detail: 'Which database?',
    });
    expect(model.counts.answer).toBe(1);
    expect(model.counts.working).toBe(0);
  });

  test('two open questions on one run count in the reason and show the first', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'running' })],
        openQuestions: new Map([
          [
            'r-a',
            [{ question: 'Which database?' }, { question: 'Which ORM?' }],
          ],
        ]),
      })
    );
    expect(model.groups[0]?.rows[0]?.attention).toEqual({
      reason: 'Asked you 2 questions',
      detail: 'Which database?',
    });
  });

  test('an open question on a finished run does not drag it back to waiting', () => {
    const model = buildFeed(
      input({
        runs: [run({ id: 'r-a', state: 'finished' })],
        openQuestions: new Map([['r-a', [{ question: 'Which database?' }]]]),
      })
    );
    expect(model.groups[0]?.rows[0]?.state).toBe('review');
    expect(model.groups[0]?.rows[0]?.attention).toBeNull();
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

describe('auxiliary runs fold into the execute run they are about', () => {
  test('a live review agent produces one checking row, not a second row', () => {
    const model = buildFeed(
      input({
        runs: [
          auxRun({ id: 'r-rev', kind: 'review', state: 'running' }),
          run({ id: 'r-exec', taskId: 't-1', state: 'finished' }),
        ],
        tasks: [task('t-1', 'Do the thing')],
      })
    );
    expect(model.total).toBe(1);
    const rows = model.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe('r-exec');
    expect(rows[0]?.state).toBe('checking');
    expect(rows[0]?.activity).toBe('AI review running');
    // The ribbon must agree with the feed, or the counts contradict the rows.
    expect(model.counts.checking).toBe(1);
    expect(model.counts.review).toBe(0);
  });

  test('a live verify agent reads as verifying, not reviewing', () => {
    const model = buildFeed(
      input({
        runs: [
          auxRun({ id: 'r-ver', kind: 'verify', state: 'running' }),
          run({ id: 'r-exec', taskId: 't-1', state: 'finished' }),
        ],
      })
    );
    expect(model.groups[0]?.rows[0]?.activity).toBe('AI verify running');
  });

  test('a finished review agent hands the run back to the human', () => {
    const model = buildFeed(
      input({
        runs: [
          auxRun({ id: 'r-rev', kind: 'review', state: 'finished' }),
          run({ id: 'r-exec', taskId: 't-1', state: 'finished', turns: 12 }),
        ],
      })
    );
    const rows = model.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('review');
    expect(rows[0]?.activity).toBe('12 turns');
  });

  test('a review agent that died says so rather than failing silently', () => {
    const model = buildFeed(
      input({
        runs: [
          auxRun({ id: 'r-rev', kind: 'review', state: 'failed' }),
          run({ id: 'r-exec', taskId: 't-1', state: 'finished' }),
        ],
      })
    );
    const rows = model.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('review');
    expect(rows[0]?.attention?.reason).toBe('The AI review agent failed');
  });

  test('an aux run whose execute run is gone still gets a row of its own', () => {
    const model = buildFeed(
      input({
        runs: [auxRun({ id: 'r-rev', kind: 'review', state: 'running' })],
      })
    );
    expect(model.groups[0]?.rows[0]?.runId).toBe('r-rev');
  });
});

describe('group configuration', () => {
  test('only run-backed states are fed; ready and blocked are ribbon-only', () => {
    expect(FEED_GROUPS).toEqual([
      'answer',
      'approve',
      'review',
      'ruling',
      'unblock',
      'failed',
      'working',
      'fixing',
      'checking',
      'landing',
    ]);
  });

  test('working gets more room than the rest', () => {
    expect(groupCap('working')).toBe(7);
    expect(groupCap('review')).toBe(5);
  });
});

describe('superseded runs collapse to one row per task', () => {
  // Three fix-loop rounds left three finished execute runs on t-1; only the
  // newest speaks for the task.
  test('older review-state runs of the same task are dropped', () => {
    const model = buildFeed(
      input({
        runs: [
          run({
            id: 'r-1',
            state: 'finished',
            createdAt: '2026-07-26T00:00:00.000Z',
          }),
          run({
            id: 'r-2',
            state: 'finished',
            createdAt: '2026-07-26T01:00:00.000Z',
          }),
          run({
            id: 'r-3',
            state: 'finished',
            createdAt: '2026-07-26T02:00:00.000Z',
          }),
        ],
      })
    );
    const review = model.groups.find((g) => g.state === 'review');
    expect(review?.rows.map((r) => r.runId)).toEqual(['r-3']);
    expect(model.counts.review).toBe(1);
  });

  test('an older failed round is history once a newer run exists', () => {
    const model = buildFeed(
      input({
        runs: [
          run({
            id: 'r-1',
            state: 'failed',
            createdAt: '2026-07-26T00:00:00.000Z',
          }),
          run({
            id: 'r-2',
            state: 'finished',
            createdAt: '2026-07-26T01:00:00.000Z',
          }),
        ],
      })
    );
    expect(model.counts.failed).toBe(0);
    expect(model.counts.review).toBe(1);
  });

  test('runs of different tasks never fold into each other', () => {
    const model = buildFeed(
      input({
        runs: [
          run({ id: 'r-1', state: 'finished' }),
          run({
            id: 'r-2',
            taskId: 't-2',
            branch: 'dispatch/t-2',
            state: 'finished',
          }),
        ],
      })
    );
    expect(model.counts.review).toBe(2);
  });

  test('rows carry the task fix-loop state for the loop status and Stop', () => {
    const loop = {
      taskId: 't-1',
      round: 2,
      cap: 5,
      state: 'reviewing',
      baseSha: 'abc',
      lastReviewedSha: null,
      updatedAt: '2026-07-26T00:00:00.000Z',
    } as const;
    const model = buildFeed(
      input({
        runs: [run({ state: 'finished' })],
        fixLoops: new Map([['t-1', loop]]),
      })
    );
    const review = model.groups.find((g) => g.state === 'review');
    expect(review?.rows[0]?.fixLoop).toEqual(loop);
  });
});

// The screenshot case behind the rule: review agents whose execute run is gone (merged away
// or healed as a zombie after a daemon restart) each keep a row of their own — three
// "failed" and three "needs review" rows all naming one task.
describe('stacked standalone review agents collapse too', () => {
  test('zombie review runs of one task collapse to the newest', () => {
    const model = buildFeed(
      input({
        runs: [
          auxRun({
            id: 'rv-1',
            kind: 'review',
            state: 'failed',
            createdAt: '2026-07-26T00:00:00.000Z',
          }),
          auxRun({
            id: 'rv-2',
            kind: 'review',
            state: 'failed',
            createdAt: '2026-07-26T01:00:00.000Z',
          }),
          auxRun({
            id: 'rv-3',
            kind: 'review',
            state: 'finished',
            createdAt: '2026-07-26T02:00:00.000Z',
          }),
        ],
      })
    );
    expect(model.total).toBe(1);
    expect(model.groups.map((g) => g.state)).toEqual(['review']);
    expect(model.groups[0]?.rows.map((r) => r.runId)).toEqual(['rv-3']);
  });

  test('an old execute round and a newer standalone review agent are one row', () => {
    const model = buildFeed(
      input({
        runs: [
          // An execute round still reading 'review', on a branch no aux run points at.
          run({
            id: 'r-old',
            branch: 'dispatch/t-1-round1',
            state: 'finished',
            createdAt: '2026-07-26T00:00:00.000Z',
          }),
          // A newer review agent for the same task whose own execute run is gone.
          auxRun({
            id: 'rv-1',
            kind: 'review',
            state: 'failed',
            createdAt: '2026-07-26T01:00:00.000Z',
          }),
        ],
      })
    );
    expect(model.total).toBe(1);
    expect(model.groups[0]?.rows.map((r) => r.runId)).toEqual(['rv-1']);
    expect(model.groups[0]?.state).toBe('failed');
  });
});

test("a live run suppresses the task's older review and failed rows", () => {
  const model = buildFeed(
    input({
      runs: [
        run({
          id: 'r-old',
          branch: 'dispatch/t-1-round1',
          state: 'finished',
          createdAt: '2026-07-26T00:00:00.000Z',
        }),
        run({
          id: 'r-live',
          branch: 'dispatch/t-1-round2',
          state: 'running',
          createdAt: '2026-07-26T01:00:00.000Z',
        }),
      ],
    })
  );
  // Only the working row: the run in flight supersedes the older round's review.
  expect(model.total).toBe(1);
  expect(model.groups.map((g) => g.state)).toEqual(['working']);
  expect(model.counts.review).toBe(0);
});
