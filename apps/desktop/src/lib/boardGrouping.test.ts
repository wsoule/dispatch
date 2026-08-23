import type { TaskDoc, TaskMeta } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { groupTasksByStatus } from './boardGrouping';

function makeTask(id: string, status: string): TaskDoc {
  const meta: TaskMeta = {
    id,
    title: `Task ${id}`,
    status,
    kind: 'task',
    parent: null,
    milestone: null,
    blockedBy: [],
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
  };
  return { meta, body: '' };
}

describe('groupTasksByStatus', () => {
  test('buckets tasks under their status, preserving the configured status order', () => {
    const tasks = [
      makeTask('a', 'ready'),
      makeTask('b', 'landed'),
      makeTask('c', 'ready'),
    ];
    const groups = groupTasksByStatus(tasks, ['draft', 'ready', 'landed']);
    expect(groups.map((g) => g.status)).toEqual(['draft', 'ready', 'landed']);
    expect(groups[0].tasks).toEqual([]);
    expect(groups[1].tasks.map((t) => t.meta.id)).toEqual(['a', 'c']);
    expect(groups[2].tasks.map((t) => t.meta.id)).toEqual(['b']);
  });

  test('a task whose status is not in the configured list is dropped from every column', () => {
    const tasks = [makeTask('a', 'ready'), makeTask('b', 'archived')];
    const groups = groupTasksByStatus(tasks, ['ready']);
    expect(groups).toEqual([{ status: 'ready', tasks: [tasks[0]] }]);
  });

  test('an empty status list returns no columns', () => {
    expect(groupTasksByStatus([makeTask('a', 'ready')], [])).toEqual([]);
  });

  test('preserves original task order within a column', () => {
    const tasks = [makeTask('z', 'ready'), makeTask('a', 'ready')];
    const groups = groupTasksByStatus(tasks, ['ready']);
    expect(groups[0].tasks.map((t) => t.meta.id)).toEqual(['z', 'a']);
  });
});
