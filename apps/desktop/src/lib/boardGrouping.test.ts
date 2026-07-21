import type { TaskDoc, TaskMeta } from '@dispatch/core';
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
  };
  return { meta, body: '' };
}

describe('groupTasksByStatus', () => {
  test('buckets tasks under their status, preserving the configured status order', () => {
    const tasks = [
      makeTask('a', 'todo'),
      makeTask('b', 'done'),
      makeTask('c', 'todo'),
    ];
    const groups = groupTasksByStatus(tasks, ['backlog', 'todo', 'done']);
    expect(groups.map((g) => g.status)).toEqual(['backlog', 'todo', 'done']);
    expect(groups[0].tasks).toEqual([]);
    expect(groups[1].tasks.map((t) => t.meta.id)).toEqual(['a', 'c']);
    expect(groups[2].tasks.map((t) => t.meta.id)).toEqual(['b']);
  });

  test('a task whose status is not in the configured list is dropped from every column', () => {
    const tasks = [makeTask('a', 'todo'), makeTask('b', 'archived')];
    const groups = groupTasksByStatus(tasks, ['todo']);
    expect(groups).toEqual([{ status: 'todo', tasks: [tasks[0]] }]);
  });

  test('an empty status list returns no columns', () => {
    expect(groupTasksByStatus([makeTask('a', 'todo')], [])).toEqual([]);
  });

  test('preserves original task order within a column', () => {
    const tasks = [makeTask('z', 'todo'), makeTask('a', 'todo')];
    const groups = groupTasksByStatus(tasks, ['todo']);
    expect(groups[0].tasks.map((t) => t.meta.id)).toEqual(['z', 'a']);
  });
});
