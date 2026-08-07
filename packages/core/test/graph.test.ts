import { describe, expect, it } from 'bun:test';

import {
  dispatchableTasks,
  findDependencyCycles,
  isDone,
  isSatisfiedForDispatch,
  readyTasks,
} from '../src/graph.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';

function make(partial: Partial<TaskMeta>): TaskDoc {
  return {
    meta: {
      id: 't-000000',
      title: 'x',
      status: 'todo',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...partial,
    },
    body: '',
  };
}

// A task Dispatch synthesized from someone else's artifact carries prose
// nobody here wrote. It exists to anchor a review, never to be worked.
describe('derived tasks are never ready or dispatchable', () => {
  it('excludes a derived task from both lists', () => {
    const derived = make({ id: 't-e00000', derivedFrom: 'github-pr:7' });
    const authored = make({ id: 't-f00000' });
    expect(readyTasks([derived, authored]).map((t) => t.meta.id)).toEqual([
      't-f00000',
    ]);
    expect(
      dispatchableTasks([derived, authored]).map((t) => t.meta.id)
    ).toEqual(['t-f00000']);
  });
});

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

describe('dispatchableTasks', () => {
  it('treats an in-review blocker as satisfied, unlike readyTasks', () => {
    const blocker = make({ id: 't-a00000', status: 'in-review' });
    const dependent = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    expect(
      dispatchableTasks([blocker, dependent]).map((t) => t.meta.id)
    ).toEqual(['t-b00000']);
    expect(readyTasks([blocker, dependent]).map((t) => t.meta.id)).toEqual([]);
  });

  it('still blocks on an in-progress or todo blocker', () => {
    const running = make({ id: 't-a00000', status: 'in-progress' });
    const waiting = make({ id: 't-c00000', status: 'todo' });
    const onRunning = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    const onWaiting = make({ id: 't-d00000', blockedBy: ['t-c00000'] });
    const ids = dispatchableTasks([running, waiting, onRunning, onWaiting]).map(
      (t) => t.meta.id
    );
    expect(ids).not.toContain('t-b00000');
    expect(ids).not.toContain('t-d00000');
  });

  it('still accepts done and cancelled blockers', () => {
    const done = make({ id: 't-a00000', status: 'done' });
    const cancelled = make({ id: 't-c00000', status: 'cancelled' });
    const dependent = make({
      id: 't-b00000',
      blockedBy: ['t-a00000', 't-c00000'],
    });
    expect(
      dispatchableTasks([done, cancelled, dependent]).map((t) => t.meta.id)
    ).toEqual(['t-b00000']);
  });

  it('sorts by priority then created date, like readyTasks', () => {
    const low = make({
      id: 't-100000',
      priority: 'low',
      created: '2026-01-01T00:00:00Z',
    });
    const urgent = make({
      id: 't-200000',
      priority: 'urgent',
      created: '2026-01-02T00:00:00Z',
    });
    expect(dispatchableTasks([low, urgent]).map((t) => t.meta.id)).toEqual([
      't-200000',
      't-100000',
    ]);
  });

  it('ignores dangling blocker ids, like readyTasks', () => {
    const dependent = make({ id: 't-b00000', blockedBy: ['t-missing'] });
    expect(dispatchableTasks([dependent])).toHaveLength(1);
  });
});

describe('isSatisfiedForDispatch', () => {
  it('is true for done, cancelled and in-review; false otherwise', () => {
    expect(isSatisfiedForDispatch(make({ status: 'done' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'cancelled' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'in-review' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'in-progress' }))).toBe(false);
    expect(isSatisfiedForDispatch(make({ status: 'todo' }))).toBe(false);
    expect(isSatisfiedForDispatch(make({ status: 'backlog' }))).toBe(false);
  });
});
