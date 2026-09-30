import type { TaskDoc } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import {
  type ChildPhaseInput,
  deriveChildPhase,
  deriveSpend,
  deriveWaves,
  summarizeWaves,
} from '../../src/orchestrator/epicPhase.js';
import type { FixLoopState } from '../../src/orchestrator/fixLoop.js';
import type { RunMeta, RunState } from '../../src/orchestrator/types.js';

function task(id: string, overrides: Partial<TaskDoc['meta']> = {}): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status: 'ready',
      kind: 'task',
      priority: 'medium',
      created: '2026-09-20T00:00:00Z',
      updated: '2026-09-20T00:00:00Z',
      blockedBy: [],
      labels: [],
      writes: [],
      risk: 'routine',
      ...overrides,
    } as TaskDoc['meta'],
    body: '',
  } as TaskDoc;
}

function run(
  id: string,
  state: RunState,
  overrides: Partial<RunMeta> = {}
): RunMeta {
  return {
    id,
    taskId: 't-1',
    taskTitle: 't-1',
    executor: 'fake',
    state,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
    ...overrides,
  };
}

function loop(
  state: FixLoopState['state'],
  overrides: Partial<FixLoopState> = {}
): FixLoopState {
  return {
    taskId: 't-1',
    round: 1,
    cap: 3,
    state,
    baseSha: 'abc',
    lastReviewedSha: null,
    updatedAt: '2026-09-20T00:00:00Z',
    ...overrides,
  };
}

function input(overrides: Partial<ChildPhaseInput> = {}): ChildPhaseInput {
  return {
    task: task('t-1'),
    liveRun: null,
    latestRun: null,
    fixLoop: null,
    blockedReason: null,
    unsatisfiedBlockers: [],
    dispatchable: true,
    ...overrides,
  };
}

describe('deriveChildPhase', () => {
  it('landed and dropped come from the done statuses', () => {
    expect(
      deriveChildPhase(input({ task: task('t-1', { status: 'landed' }) })).phase
    ).toBe('landed');
    expect(
      deriveChildPhase(input({ task: task('t-1', { status: 'dropped' }) }))
        .phase
    ).toBe('dropped');
    // Legacy names resolve through canonicalStatus.
    expect(
      deriveChildPhase(input({ task: task('t-1', { status: 'done' }) })).phase
    ).toBe('landed');
  });

  it('a done status beats a live run', () => {
    const derived = deriveChildPhase(
      input({
        task: task('t-1', { status: 'landed' }),
        liveRun: run('r-1', 'running'),
      })
    );
    expect(derived.phase).toBe('landed');
    expect(derived.runId).toBe('r-1');
  });

  it('landing', () => {
    expect(
      deriveChildPhase(input({ task: task('t-1', { status: 'landing' }) }))
        .phase
    ).toBe('landing');
  });

  it('blocked by an adjudicated finding carries the reason, and beats a loop', () => {
    const derived = deriveChildPhase(
      input({
        task: task('t-1', { status: 'review' }),
        blockedReason: 'task is blocked by an adjudicated finding: t-1',
        fixLoop: loop('implementing'),
      })
    );
    expect(derived.phase).toBe('blocked');
    expect(derived.reason).toContain('adjudicated finding');
  });

  it('blocked by the label FixLoop.blockTask adds', () => {
    expect(
      deriveChildPhase(
        input({ task: task('t-1', { status: 'review', labels: ['blocked'] }) })
      ).phase
    ).toBe('blocked');
  });

  it('fixing while the loop is implementing, even with a live execute run', () => {
    const derived = deriveChildPhase(
      input({
        task: task('t-1', { status: 'working' }),
        fixLoop: loop('implementing'),
        liveRun: run('r-2', 'running', { kind: 'execute' }),
      })
    );
    expect(derived.phase).toBe('fixing');
    expect(derived.runId).toBe('r-2');
  });

  it('reviewing from the loop state or a live review/verify run', () => {
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'review' }),
          fixLoop: loop('reviewing'),
        })
      ).phase
    ).toBe('reviewing');
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'review' }),
          liveRun: run('r-3', 'running', { kind: 'review' }),
        })
      ).phase
    ).toBe('reviewing');
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'review' }),
          liveRun: run('r-3', 'provisioning', { kind: 'verify' }),
        })
      ).phase
    ).toBe('reviewing');
  });

  it('working on a live execute run, including a pre-kind run', () => {
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'working' }),
          liveRun: run('r-4', 'awaiting-approval', { kind: 'execute' }),
        })
      ).phase
    ).toBe('working');
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'working' }),
          liveRun: run('r-4', 'running'),
        })
      ).phase
    ).toBe('working');
  });

  it('capped reads "needs a ruling" for exhausted rounds and the detail otherwise', () => {
    const exhausted = deriveChildPhase(
      input({
        task: task('t-1', { status: 'review' }),
        fixLoop: loop('capped', { stopReason: 'rounds-exhausted' }),
      })
    );
    expect(exhausted.phase).toBe('capped');
    expect(exhausted.reason).toBe('needs a ruling');
    const errored = deriveChildPhase(
      input({
        task: task('t-1', { status: 'review' }),
        fixLoop: loop('capped', {
          stopReason: 'error',
          stopDetail: 'review died',
        }),
      })
    );
    expect(errored.reason).toBe('review died');
  });

  it('failed from the latest run when nothing is live and the task is not in review', () => {
    const derived = deriveChildPhase(
      input({
        task: task('t-1', { status: 'ready' }),
        latestRun: run('r-5', 'failed', { error: 'boom' }),
      })
    );
    expect(derived.phase).toBe('failed');
    expect(derived.reason).toBe('boom');
    expect(derived.runId).toBe('r-5');
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'ready' }),
          latestRun: run('r-5', 'interrupted-dirty'),
        })
      ).phase
    ).toBe('failed');
    // A failed run behind a task already in review is history, not a phase.
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'review' }),
          latestRun: run('r-5', 'failed'),
        })
      ).phase
    ).toBe('needs-review');
  });

  it('needs-review for a parked review with no loop in flight', () => {
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'review' }),
          latestRun: run('r-6', 'finished'),
          fixLoop: loop('complete'),
        })
      ).phase
    ).toBe('needs-review');
  });

  it('held for a critical-risk ready child, before waiting', () => {
    expect(
      deriveChildPhase(
        input({
          task: task('t-1', { status: 'ready', risk: 'critical' }),
          unsatisfiedBlockers: ['t-0'],
        })
      ).phase
    ).toBe('held');
  });

  it('waiting names the unsatisfied blockers', () => {
    const derived = deriveChildPhase(
      input({
        task: task('t-1', { status: 'ready' }),
        unsatisfiedBlockers: ['t-0', 't-2'],
        dispatchable: false,
      })
    );
    expect(derived.phase).toBe('waiting');
    expect(derived.reason).toBe('waiting on t-0, t-2');
  });

  it('queued when ready and dispatchable, draft otherwise', () => {
    expect(deriveChildPhase(input()).phase).toBe('queued');
    expect(
      deriveChildPhase(
        input({ task: task('t-1', { status: 'ready' }), dispatchable: false })
      ).phase
    ).toBe('draft');
    expect(
      deriveChildPhase(input({ task: task('t-1', { status: 'draft' }) })).phase
    ).toBe('draft');
  });
});

describe('deriveWaves', () => {
  it('a chain counts depth from 1', () => {
    const waves = deriveWaves([
      task('a'),
      task('b', { blockedBy: ['a'] }),
      task('c', { blockedBy: ['b'] }),
    ]);
    expect([...waves]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('a diamond takes the deepest blocker', () => {
    const waves = deriveWaves([
      task('a'),
      task('b', { blockedBy: ['a'] }),
      task('c', { blockedBy: ['a'] }),
      task('d', { blockedBy: ['b', 'c'] }),
      task('e', { blockedBy: ['a', 'd'] }),
    ]);
    expect(waves.get('d')).toBe(3);
    expect(waves.get('e')).toBe(4);
  });

  it('a blocker outside the epic does not count', () => {
    const waves = deriveWaves([task('a', { blockedBy: ['t-outside'] })]);
    expect(waves.get('a')).toBe(1);
  });

  it('a self-edge and a cycle yield the longest acyclic depth', () => {
    expect(deriveWaves([task('a', { blockedBy: ['a'] })]).get('a')).toBe(1);
    const waves = deriveWaves([
      task('a', { blockedBy: ['b'] }),
      task('b', { blockedBy: ['a'] }),
      task('c', { blockedBy: ['b'] }),
    ]);
    // Whichever of a/b is entered first reads as 1, the other as 2; c sits
    // one past b in every case.
    expect(waves.get('c')).toBe((waves.get('b') ?? 0) + 1);
    expect(Math.max(waves.get('a') ?? 0, waves.get('b') ?? 0)).toBe(2);
  });

  it('10 → 130 → 1 reads as waves 1, 2, 3', () => {
    const readers = Array.from({ length: 10 }, (_, i) => task(`r-${i}`));
    const workers = Array.from({ length: 130 }, (_, i) =>
      task(`w-${i}`, { blockedBy: readers.map((r) => r.meta.id) })
    );
    const synth = task('s', { blockedBy: workers.map((w) => w.meta.id) });
    const waves = deriveWaves([...readers, ...workers, synth]);
    expect(waves.get('r-0')).toBe(1);
    expect(waves.get('w-129')).toBe(2);
    expect(waves.get('s')).toBe(3);
  });
});

describe('deriveSpend', () => {
  const runs = [
    run('r-1', 'finished', { createdAt: '2026-09-20T01:00:00Z', costUsd: 4 }),
    run('r-2', 'running', { createdAt: '2026-09-20T02:00:00Z' }),
    run('r-3', 'failed', { createdAt: '2026-09-19T00:00:00Z', costUsd: 9 }),
  ];

  it('windows by startedAt, charging the estimate for live runs', () => {
    expect(
      deriveSpend(runs, '2026-09-20T00:00:00Z', 10, {
        maxSpendUsd: 60,
        maxRuns: 20,
      })
    ).toEqual({
      settledUsd: 4,
      liveCount: 1,
      estimatedLiveUsd: 10,
      runsStarted: 2,
      maxSpendUsd: 60,
      maxRuns: 20,
    });
  });

  it('a null window counts every run', () => {
    const spend = deriveSpend(runs, null, 7.5, {
      maxSpendUsd: null,
      maxRuns: null,
    });
    expect(spend.settledUsd).toBe(13);
    expect(spend.runsStarted).toBe(3);
    expect(spend.estimatedLiveUsd).toBe(7.5);
    expect(spend.maxSpendUsd).toBeNull();
  });

  it('an undefined costUsd counts as zero', () => {
    const spend = deriveSpend(
      [run('r-1', 'finished'), run('r-2', 'cancelled')],
      null,
      10,
      { maxSpendUsd: null, maxRuns: null }
    );
    expect(spend.settledUsd).toBe(0);
    expect(spend.liveCount).toBe(0);
  });
});

describe('summarizeWaves', () => {
  it('groups children by wave and counts phases in wave order', () => {
    const waves = summarizeWaves([
      {
        id: 'a',
        title: 'a',
        status: 'ready',
        phase: 'queued',
        wave: 2,
        openFindings: 0,
      },
      {
        id: 'b',
        title: 'b',
        status: 'landed',
        phase: 'landed',
        wave: 1,
        openFindings: 0,
      },
      {
        id: 'c',
        title: 'c',
        status: 'ready',
        phase: 'waiting',
        wave: 2,
        openFindings: 0,
      },
    ]);
    expect(waves).toEqual([
      { index: 1, total: 1, byPhase: { landed: 1 } },
      { index: 2, total: 2, byPhase: { queued: 1, waiting: 1 } },
    ]);
  });
});
