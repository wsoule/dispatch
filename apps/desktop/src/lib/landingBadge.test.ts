import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueSnapshot,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  landingBadgeTitle,
  landingEntryByTaskId,
  landingStateByTaskId,
  landingStepLabel,
} from './landingBadge';

function entry(
  taskId: string,
  state: MergeQueueEntryState,
  runId = `r-${taskId}`
): MergeQueueEntry {
  return {
    runId,
    taskId,
    taskTitle: taskId,
    state,
    enqueuedAt: '2026-09-24T00:00:00.000Z',
  };
}

function queue(entries: MergeQueueEntry[]): MergeQueueSnapshot {
  return { entries, history: [] };
}

describe('landingStateByTaskId', () => {
  test('is empty before the queue loads', () => {
    expect(landingStateByTaskId(null).size).toBe(0);
  });

  test('maps every task still in the queue to its entry state', () => {
    const map = landingStateByTaskId(
      queue([
        entry('t-a', 'verifying'),
        entry('t-b', 'blocked-environment'),
        entry('t-c', 'merged'),
        entry('t-d', 'failed'),
      ])
    );
    expect([...map]).toEqual([
      ['t-a', 'verifying'],
      ['t-b', 'blocked-environment'],
    ]);
  });

  test('keeps the first (queue-order) entry when a task has two runs queued', () => {
    const map = landingStateByTaskId(
      queue([entry('t-a', 'merging', 'r-1'), entry('t-a', 'queued', 'r-2')])
    );
    expect(map.get('t-a')).toBe('merging');
  });

  test('ignores history, where the queue keeps finished entries', () => {
    expect(
      landingStateByTaskId({ entries: [], history: [entry('t-a', 'merged')] })
        .size
    ).toBe(0);
  });
});

test('landingEntryByTaskId keeps each task’s first live entry, whole', () => {
  const first = entry('t-a', 'merging', 'r-1');
  const map = landingEntryByTaskId(
    queue([first, entry('t-a', 'queued', 'r-2'), entry('t-b', 'merged')])
  );
  expect([...map]).toEqual([['t-a', first]]);
});

test('landingBadgeTitle names the queue step', () => {
  expect(landingStepLabel('blocked-environment')).toBe(
    'held until the checkout is clean'
  );
  expect(landingBadgeTitle('verifying')).toBe('Landing · verifying');
  expect(landingBadgeTitle('waiting-github')).toBe(
    'Landing · waiting on GitHub'
  );
});
