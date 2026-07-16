import { describe, it, expect } from 'vitest';
import { readyTasks, isDone } from '../src/graph.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';

function make(partial: Partial<TaskMeta>): TaskDoc {
  return {
    meta: {
      id: 't-000000', title: 'x', status: 'todo', kind: 'task', parent: null,
      blockedBy: [], labels: [], priority: 'none', assignee: 'none',
      created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', external: null,
      ...partial,
    },
    body: '',
  };
}

describe('readyTasks', () => {
  it('includes todo tasks whose blockers are done/cancelled, excludes others', () => {
    const done = make({ id: 't-d00000', status: 'done' });
    const open = make({ id: 't-o00000', status: 'in-progress' });
    const ready = make({ id: 't-r00000', blockedBy: ['t-d00000'] });
    const blocked = make({ id: 't-b00000', blockedBy: ['t-o00000'] });
    const ids = readyTasks([done, open, ready, blocked]).map(t => t.meta.id);
    expect(ids).toContain('t-r00000');
    expect(ids).not.toContain('t-b00000');
    expect(ids).not.toContain('t-o00000'); // not todo
  });
  it('excludes epics and non-todo statuses', () => {
    const epic = make({ id: 'e-100000', kind: 'epic' });
    const review = make({ id: 't-200000', status: 'in-review' });
    expect(readyTasks([epic, review])).toEqual([]);
  });
  it('treats dangling blocker ids as non-blocking', () => {
    const t = make({ id: 't-300000', blockedBy: ['t-ghost0'] });
    expect(readyTasks([t])).toHaveLength(1);
  });
  it('sorts by priority then created', () => {
    const low = make({ id: 't-400000', priority: 'low', created: '2026-01-01T00:00:00Z' });
    const urgent = make({ id: 't-500000', priority: 'urgent', created: '2026-01-02T00:00:00Z' });
    expect(readyTasks([low, urgent])[0].meta.id).toBe('t-500000');
  });
});

describe('isDone', () => {
  it('true for done and cancelled only', () => {
    expect(isDone(make({ status: 'done' }))).toBe(true);
    expect(isDone(make({ status: 'cancelled' }))).toBe(true);
    expect(isDone(make({ status: 'in-review' }))).toBe(false);
  });
});
