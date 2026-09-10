import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { computeBlockedIds } from './taskGraph';

function makeTask(
  id: string,
  status: string,
  blockedBy: string[] = []
): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status,
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy,
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
    },
    body: '',
  };
}

describe('computeBlockedIds', () => {
  test('a task blocked by a non-terminal task is blocked', () => {
    const tasks = [makeTask('a', 'ready'), makeTask('b', 'ready', ['a'])];
    expect(computeBlockedIds(tasks)).toEqual(new Set(['b']));
  });

  test('a task blocked only by done/cancelled tasks is not blocked', () => {
    const tasks = [
      makeTask('a', 'landed'),
      makeTask('b', 'dropped'),
      makeTask('c', 'ready', ['a', 'b']),
    ];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });

  test('a dangling blocker id (no matching task) does not block', () => {
    const tasks = [makeTask('c', 'ready', ['nonexistent'])];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });

  test('a task with no blockedBy is never blocked', () => {
    const tasks = [makeTask('a', 'ready')];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });
});
