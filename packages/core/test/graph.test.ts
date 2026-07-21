import { describe, expect, it } from 'bun:test';

import { findDependencyCycles, isDone, readyTasks } from '../src/graph.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';

function make(partial: Partial<TaskMeta>): TaskDoc {
  return {
    meta: {
      id: 't-000000',
      title: 'x',
      status: 'todo',
      kind: 'task',
      parent: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      external: null,
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
    const ids = readyTasks([done, open, ready, blocked]).map((t) => t.meta.id);
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
    const low = make({
      id: 't-400000',
      priority: 'low',
      created: '2026-01-01T00:00:00Z',
    });
    const urgent = make({
      id: 't-500000',
      priority: 'urgent',
      created: '2026-01-02T00:00:00Z',
    });
    expect(readyTasks([low, urgent])[0].meta.id).toBe('t-500000');
  });
  it('breaks priority ties by created ascending', () => {
    const newer = make({
      id: 't-600000',
      priority: 'high',
      created: '2026-01-02T00:00:00Z',
    });
    const older = make({
      id: 't-700000',
      priority: 'high',
      created: '2026-01-01T00:00:00Z',
    });
    expect(readyTasks([newer, older]).map((t) => t.meta.id)).toEqual([
      't-700000',
      't-600000',
    ]);
  });
  it('requires every blocker done', () => {
    const done = make({ id: 't-d10000', status: 'done' });
    const inProgress = make({ id: 't-p10000', status: 'in-progress' });
    const cancelled = make({ id: 't-c10000', status: 'cancelled' });

    const notReady = make({
      id: 't-n10000',
      blockedBy: ['t-d10000', 't-p10000'],
    });
    expect(
      readyTasks([done, inProgress, notReady]).map((t) => t.meta.id)
    ).not.toContain('t-n10000');

    const ready = make({ id: 't-y10000', blockedBy: ['t-d10000', 't-c10000'] });
    expect(
      readyTasks([done, cancelled, ready]).map((t) => t.meta.id)
    ).toContain('t-y10000');
  });
});

describe('isDone', () => {
  it('true for done and cancelled only', () => {
    expect(isDone(make({ status: 'done' }))).toBe(true);
    expect(isDone(make({ status: 'cancelled' }))).toBe(true);
    expect(isDone(make({ status: 'in-review' }))).toBe(false);
  });
});

describe('findDependencyCycles', () => {
  it('returns no cycles for an acyclic graph', () => {
    const a = make({ id: 't-a00000', blockedBy: [] });
    const b = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    const c = make({ id: 't-c00000', blockedBy: ['t-b00000'] });
    expect(findDependencyCycles([a, b, c])).toEqual([]);
  });

  it('finds a direct two-task cycle', () => {
    const a = make({ id: 't-a00000', blockedBy: ['t-b00000'] });
    const b = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    const cycles = findDependencyCycles([a, b]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1]);
    expect(new Set(cycles[0])).toEqual(new Set(['t-a00000', 't-b00000']));
  });

  it('finds a longer cycle through an intermediate task', () => {
    const a = make({ id: 't-a00000', blockedBy: ['t-b00000'] });
    const b = make({ id: 't-b00000', blockedBy: ['t-c00000'] });
    const c = make({ id: 't-c00000', blockedBy: ['t-a00000'] });
    const cycles = findDependencyCycles([a, b, c]);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(
      new Set(['t-a00000', 't-b00000', 't-c00000'])
    );
  });

  it('ignores self-references and dangling ids (reported separately by doctor)', () => {
    const a = make({ id: 't-a00000', blockedBy: ['t-a00000', 't-ghost0'] });
    expect(findDependencyCycles([a])).toEqual([]);
  });

  it('does not block on an acyclic diamond of shared dependencies', () => {
    const a = make({ id: 't-a00000', blockedBy: [] });
    const b = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    const c = make({ id: 't-c00000', blockedBy: ['t-a00000'] });
    const d = make({ id: 't-d00000', blockedBy: ['t-b00000', 't-c00000'] });
    expect(findDependencyCycles([a, b, c, d])).toEqual([]);
  });
});
