import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { StageInput } from './taskPageMode';
import {
  defaultTaskPageMode,
  executeRuns,
  lifecycleStages,
  reviewedRun,
  runsNewestFirst,
} from './taskPageMode';

function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'T',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/wt',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:05:00.000Z',
    ...overrides,
  };
}

const TASK = { statusType: 'unstarted', isContainer: false } as const;

describe('defaultTaskPageMode', () => {
  test('a task nobody has dispatched opens on its spec', () => {
    expect(defaultTaskPageMode({ ...TASK, latestRun: undefined })).toBe('spec');
  });

  test('a live run opens on the run, a finished one on its review', () => {
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run(),
      })
    ).toBe('run');
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run({ state: 'finished' }),
      })
    ).toBe('review');
  });

  test('an open PR still reads as review; a failed run shows its transcript', () => {
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run({ state: 'finished', prUrl: 'https://x/pr/1' }),
      })
    ).toBe('review');
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run({ state: 'failed' }),
      })
    ).toBe('run');
  });

  test('a task not started, or reopened, opens on its spec unless a run is live', () => {
    const merged = run({
      state: 'finished',
      reviewedAt: '2026-09-23T11:00:00Z',
      reviewAction: 'merge',
    });
    for (const statusType of ['triage', 'backlog', 'unstarted'] as const) {
      for (const latestRun of [
        merged,
        run({ state: 'failed' }),
        run({ state: 'finished' }),
      ]) {
        expect(defaultTaskPageMode({ ...TASK, statusType, latestRun })).toBe(
          'spec'
        );
      }
      expect(
        defaultTaskPageMode({ ...TASK, statusType, latestRun: run() })
      ).toBe('run');
    }
  });

  test('done work shows its summary, whatever its runs say', () => {
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'completed',
        latestRun: run(),
      })
    ).toBe('summary');
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'canceled',
        latestRun: undefined,
      })
    ).toBe('summary');
  });

  test('a merged run on a started task reads as landed, a discarded one as back to spec', () => {
    const reviewed = { state: 'finished', reviewedAt: '2026-09-23T11:00:00Z' };
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run({ ...reviewed, reviewAction: 'merge' } as RunMeta),
      })
    ).toBe('summary');
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        latestRun: run({ ...reviewed, reviewAction: 'discard' } as RunMeta),
      })
    ).toBe('spec');
  });

  test('a container opens on its plan', () => {
    expect(
      defaultTaskPageMode({
        ...TASK,
        statusType: 'started',
        isContainer: true,
        latestRun: undefined,
      })
    ).toBe('plan');
  });
});

test('executeRuns keeps the agent’s own runs, newest first', () => {
  const runs = executeRuns([
    run({ id: 'r-old', createdAt: '2026-09-01T00:00:00Z' }),
    run({ id: 'r-review', kind: 'review', createdAt: '2026-09-10T00:00:00Z' }),
    run({ id: 'r-new', createdAt: '2026-09-05T00:00:00Z' }),
  ]);
  expect(runs.map((r) => r.id)).toEqual(['r-new', 'r-old']);
});

test('runsNewestFirst keeps every kind', () => {
  const runs = runsNewestFirst([
    run({ id: 'r-old', createdAt: '2026-09-01T00:00:00Z' }),
    run({ id: 'r-verify', kind: 'verify', createdAt: '2026-09-10T00:00:00Z' }),
  ]);
  expect(runs.map((r) => r.id)).toEqual(['r-verify', 'r-old']);
});

describe('reviewedRun', () => {
  const first = run({ id: 'r-a', branch: 'dispatch/t-1' });
  const second = run({ id: 'r-b', branch: 'dispatch/t-1-b' });
  const execute = [second, first];

  test('an execute run is judged as itself', () => {
    expect(reviewedRun(first, execute)).toBe(first);
    expect(reviewedRun(undefined, [])).toBeUndefined();
  });

  test('a review or verify run points at the work it checked', () => {
    const review = run({
      id: 'r-rev',
      kind: 'review',
      baseBranch: 'dispatch/t-1',
    });
    expect(reviewedRun(review, execute)).toBe(first);
    const orphan = run({ id: 'r-ver', kind: 'verify', baseBranch: 'gone' });
    expect(reviewedRun(orphan, execute)).toBe(second);
  });
});

describe('lifecycleStages', () => {
  const base: StageInput = {
    ...TASK,
    latestRun: undefined,
    runs: [],
    criteriaCount: 3,
    writesCount: 2,
    unmetBlockers: 0,
    statusLabel: 'Ready',
    children: { total: 0, done: 0, running: 0 },
  };

  test('a task nobody dispatched is at its spec, everything after pending', () => {
    const stages = lifecycleStages(base);
    expect(stages.map((s) => [s.mode, s.progress, s.caption])).toEqual([
      ['spec', 'current', '3 criteria · 2 writes'],
      ['run', 'pending', 'Not dispatched'],
      ['review', 'pending', '—'],
      ['summary', 'pending', '—'],
    ]);
  });

  test('a live run is current and carries its clock', () => {
    const live = run();
    const stages = lifecycleStages({
      ...base,
      statusType: 'started',
      latestRun: live,
      runs: [live],
    });
    expect(stages[0]?.progress).toBe('done');
    expect(stages[1]).toMatchObject({
      progress: 'current',
      caption: 'Working',
      liveSince: live.createdAt,
    });
  });

  test('a failed run marks the run stage failed, with its spend', () => {
    const failed = run({ state: 'failed', costUsd: 0.5 });
    const stages = lifecycleStages({
      ...base,
      statusType: 'started',
      latestRun: failed,
      runs: [failed],
    });
    expect(stages[1]).toMatchObject({
      progress: 'failed',
      caption: '1 run · $0.50',
    });
  });

  test('landing with no agent run skips the run and review stages', () => {
    const stages = lifecycleStages({
      ...base,
      statusType: 'completed',
      statusLabel: 'Landed',
    });
    expect(stages.map((s) => s.progress)).toEqual([
      'done',
      'skipped',
      'skipped',
      'current',
    ]);
    expect(stages[3]?.caption).toBe('Landed');
  });

  test('a reopened task is back at its spec, its old runs kept as history', () => {
    const merged = run({
      state: 'finished',
      reviewedAt: '2026-09-23T11:00:00Z',
      reviewAction: 'merge',
      costUsd: 0.25,
    });
    const stages = lifecycleStages({
      ...base,
      latestRun: merged,
      runs: [merged],
    });
    expect(stages.map((s) => [s.mode, s.progress, s.caption])).toEqual([
      ['spec', 'current', '3 criteria · 2 writes'],
      ['run', 'pending', '1 run · $0.25'],
      ['review', 'pending', 'Merged'],
      ['summary', 'pending', '—'],
    ]);
  });

  test('blockers lead the spec caption', () => {
    expect(lifecycleStages({ ...base, unmetBlockers: 2 })[0]?.caption).toBe(
      'Waits on 2 tasks'
    );
  });

  test('a container tracks spec, plan and summary', () => {
    const stages = lifecycleStages({
      ...base,
      statusType: 'started',
      isContainer: true,
      children: { total: 15, done: 5, running: 2 },
    });
    expect(stages.map((s) => [s.mode, s.progress, s.caption])).toEqual([
      ['spec', 'done', '3 criteria · 2 writes'],
      ['plan', 'current', '5/15 done · 2 running'],
      ['summary', 'pending', '—'],
    ]);
  });
});
