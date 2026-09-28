import type { RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { DEFAULT_STATUS_MODEL, readyTasks } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import type { ReadinessInput } from './dispatchReadiness';
import { dispatchReadiness, unmetBlockers } from './dispatchReadiness';

function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: id,
      status: 'ready',
      blockedBy: [],
      writes: [],
      ...overrides,
    },
  } as TaskListItem;
}

function input(
  subject: TaskListItem,
  others: TaskListItem[] = [],
  overrides: Partial<ReadinessInput> = {}
): ReadinessInput {
  return {
    task: subject,
    body: { description: 'Do the thing.', criteria: ['it works'] },
    tasksById: new Map(
      [subject, ...others].map((t) => [t.meta.id, t] as const)
    ),
    model: DEFAULT_STATUS_MODEL,
    liveRun: undefined,
    reading: undefined,
    liveClaims: [],
    ...overrides,
  };
}

function tones(result: ReturnType<typeof dispatchReadiness>) {
  return Object.fromEntries(result.checks.map((c) => [c.id, c.tone]));
}

describe('dispatchReadiness', () => {
  test('a specified, unblocked task with writes passes every check', () => {
    const result = dispatchReadiness(
      input(task('t-1', { writes: ['src/**'] }))
    );
    expect(tones(result)).toEqual({
      blockers: 'pass',
      spec: 'pass',
      writes: 'pass',
    });
    expect(result).toMatchObject({
      canDispatch: true,
      blocked: false,
      warnings: 0,
    });
  });

  test('unmet blockers hold it back and name the tasks', () => {
    const subject = task('t-1', { blockedBy: ['t-2', 't-3'] });
    const result = dispatchReadiness(
      input(subject, [task('t-2'), task('t-3', { status: 'landed' })])
    );
    expect(result.blocked).toBe(true);
    expect(result.checks[0]).toMatchObject({
      tone: 'block',
      label: 'Waits on 1 task',
      taskIds: ['t-2'],
    });
    // Still dispatchable: going ahead of a blocker is the person's call.
    expect(result.canDispatch).toBe(true);
  });

  test('a bare title and no writes are warnings', () => {
    const result = dispatchReadiness(
      input(task('t-1'), [], { body: { description: '', criteria: [] } })
    );
    expect(tones(result)).toMatchObject({ spec: 'warn', writes: 'warn' });
    expect(result.warnings).toBe(2);
    expect(result.checks.find((c) => c.id === 'spec')?.label).toBe(
      'Only a title'
    );
  });

  test('the daemon’s reading wins over the local heuristic', () => {
    const result = dispatchReadiness(
      input(task('t-1'), [], {
        reading: {
          level: 3,
          label: 'Criteria and surface named',
          confidence: 0.9,
          splitProbability: 0,
        },
        body: { description: '', criteria: [] },
      })
    );
    expect(result.checks.find((c) => c.id === 'spec')).toMatchObject({
      tone: 'pass',
      label: 'Criteria and surface named',
    });
  });

  test('the spec is pending while the body loads', () => {
    const result = dispatchReadiness(input(task('t-1'), [], { body: null }));
    expect(result.checks.find((c) => c.id === 'spec')?.tone).toBe('pending');
  });

  test('a live run elsewhere on the same files is an overlap', () => {
    const result = dispatchReadiness(
      input(task('t-1', { writes: ['src/api/**'] }), [], {
        liveClaims: [
          { runId: 'r-9', taskId: 't-9', claims: ['src/api/routes.ts'] },
          { runId: 'r-1', taskId: 't-1', claims: ['src/api/x.ts'] },
        ],
      })
    );
    expect(result.checks.find((c) => c.id === 'overlap')).toMatchObject({
      tone: 'warn',
      taskIds: ['t-9'],
    });
  });

  test('no declared writes is one warning, not an overlap with every live run', () => {
    const result = dispatchReadiness(
      input(task('t-1'), [], {
        liveClaims: [{ runId: 'r-9', taskId: 't-9', claims: ['a.ts'] }],
      })
    );
    expect(result.checks.map((c) => c.id)).toEqual([
      'blockers',
      'spec',
      'writes',
    ]);
  });

  test('its own live run is a hard stop', () => {
    const result = dispatchReadiness(
      input(task('t-1'), [], {
        liveRun: { state: 'running' } as RunMeta,
      })
    );
    expect(result.canDispatch).toBe(false);
  });

  test('a completed or canceled task is closed to dispatch', () => {
    for (const status of ['landed', 'dropped']) {
      const result = dispatchReadiness(input(task('t-1', { status })));
      expect(result).toMatchObject({ canDispatch: false, closed: true });
    }
    expect(dispatchReadiness(input(task('t-1'))).closed).toBe(false);
  });
});

describe('a blocker id naming no task', () => {
  const subject = task('t-1', { blockedBy: ['t-gone'] });

  test('never blocks, as in the daemon’s ready queue', () => {
    const tasks = [subject];
    expect(readyTasks(tasks).map((t) => t.meta.id)).toEqual(['t-1']);
    expect(
      unmetBlockers(subject, new Map([['t-1', subject]]), DEFAULT_STATUS_MODEL)
    ).toEqual([]);
  });

  test('reads as a warning, not a hold', () => {
    const result = dispatchReadiness(input(subject));
    expect(result.blocked).toBe(false);
    expect(result.checks[0]).toMatchObject({
      tone: 'warn',
      label: '1 blocker not found',
    });
  });

  test('an unmet blocker beside it still holds the task back', () => {
    const result = dispatchReadiness(
      input(task('t-1', { blockedBy: ['t-gone', 't-2'] }), [task('t-2')])
    );
    expect(result.checks[0]).toMatchObject({
      tone: 'block',
      taskIds: ['t-2'],
    });
  });
});
