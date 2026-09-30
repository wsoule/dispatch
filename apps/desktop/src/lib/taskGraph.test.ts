import type { TaskDoc } from '@dispatch/core/browser';
import { defaultTaskFields, statusModelOf } from '@dispatch/core/browser';
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
      ...defaultTaskFields(),
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

  test('terminal is by the passed model: a mirrored Done or Canceled blocker is resolved', () => {
    const linear = statusModelOf({
      statusDefinitions: [
        { name: 'Todo', type: 'unstarted', color: null },
        { name: 'Done', type: 'completed', color: null },
        { name: 'Canceled', type: 'canceled', color: null },
      ],
    });
    const tasks = [
      makeTask('a', 'Done'),
      makeTask('b', 'Canceled'),
      makeTask('c', 'Todo', ['a', 'b']),
    ];
    expect(computeBlockedIds(tasks, linear)).toEqual(new Set());
    // The built-in model has never heard of Done: it reads as open work.
    expect(computeBlockedIds(tasks)).toEqual(new Set(['c']));
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
