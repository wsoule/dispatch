import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { deriveEpicPulse } from './epicPulse';

function task(id: string): TaskDoc {
  return { meta: { id, title: id } } as TaskDoc;
}

function run(taskId: string, over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: `r-${taskId}`,
    taskId,
    taskTitle: taskId,
    executor: 'claude',
    state: 'running',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function runs(...entries: RunMeta[]): Map<string, RunMeta> {
  return new Map(entries.map((r) => [r.taskId, r]));
}

const four = [task('t-1'), task('t-2'), task('t-3'), task('t-4')];
const none = new Set<string>();

describe('deriveEpicPulse', () => {
  test('an idle epic says so plainly', () => {
    const p = deriveEpicPulse(four, runs(), none);
    expect(p.label).toBe('nothing running');
    expect(p.state).toBeNull();
  });

  test('ready tasks are reported when nothing else is happening', () => {
    const p = deriveEpicPulse(four, runs(), new Set(['t-1', 't-2']));
    expect(p.label).toBe('2 ready');
    expect(p.state).toBe('ready');
  });

  test('running beats merely ready', () => {
    const p = deriveEpicPulse(four, runs(run('t-1')), new Set(['t-2', 't-3']));
    expect(p.label).toBe('1 running');
  });

  test('review beats ready but loses to running', () => {
    expect(
      deriveEpicPulse(
        four,
        runs(run('t-1', { state: 'finished' })),
        new Set(['t-2'])
      ).label
    ).toBe('1 to review');
    expect(
      deriveEpicPulse(
        four,
        runs(run('t-1', { state: 'finished' }), run('t-2')),
        none
      ).label
    ).toBe('1 running');
  });

  // The ordering is the feature: a header that listed everything would make the reader do the
  // triage the pulse exists to do for them.
  test('needing a human outranks everything else', () => {
    const p = deriveEpicPulse(
      four,
      runs(
        run('t-1'),
        run('t-2'),
        run('t-3', { state: 'finished' }),
        run('t-4', { state: 'awaiting-approval' })
      ),
      new Set(['t-1'])
    );
    expect(p.label).toBe('1 need you');
    expect(p.state).toBe('waiting');
  });

  // Waiting and failed differ in how you fix them but not in who is blocking, so they share
  // one counter rather than competing for the single line.
  test('waiting and failed are counted together', () => {
    const p = deriveEpicPulse(
      four,
      runs(
        run('t-1', { state: 'awaiting-approval' }),
        run('t-2', { state: 'failed' })
      ),
      none
    );
    expect(p.label).toBe('2 need you');
  });

  test('closed-out runs do not register at all', () => {
    const p = deriveEpicPulse(
      four,
      runs(
        run('t-1', {
          state: 'finished',
          reviewedAt: '2026-07-26T01:00:00.000Z',
        })
      ),
      none
    );
    expect(p.label).toBe('nothing running');
  });

  test('an empty epic does not crash or claim activity', () => {
    expect(deriveEpicPulse([], runs(), none).label).toBe('nothing running');
  });
});
