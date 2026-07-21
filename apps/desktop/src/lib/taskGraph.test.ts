import type { TaskDoc } from '@dispatch/core';
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
    },
    body: '',
  };
}

describe('computeBlockedIds', () => {
  test('a task blocked by a non-terminal task is blocked', () => {
    const tasks = [makeTask('a', 'todo'), makeTask('b', 'todo', ['a'])];
    expect(computeBlockedIds(tasks)).toEqual(new Set(['b']));
  });

  test('a task blocked only by done/cancelled tasks is not blocked', () => {
    const tasks = [
      makeTask('a', 'done'),
      makeTask('b', 'cancelled'),
      makeTask('c', 'todo', ['a', 'b']),
    ];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });

  test('a dangling blocker id (no matching task) does not block', () => {
    const tasks = [makeTask('c', 'todo', ['nonexistent'])];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });

  test('a task with no blockedBy is never blocked', () => {
    const tasks = [makeTask('a', 'todo')];
    expect(computeBlockedIds(tasks)).toEqual(new Set());
  });
});
