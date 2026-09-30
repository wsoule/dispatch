import type { TaskListItem } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  childrenByParent,
  DIRECT_BAND,
  flightScope,
  sameScope,
} from './flightScope';

function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: id,
      status: 'ready',
      kind: 'task',
      parent: null,
      blockedBy: [],
      created: '2026-09-01T00:00:00.000Z',
      dueDate: null,
      ...overrides,
    },
  } as TaskListItem;
}

describe('flightScope', () => {
  test('a milestone plans its direct children, in no bands', () => {
    const tasks = [
      task('e-m', { kind: 'milestone' }),
      task('t-b', { parent: 'e-m' }),
      task('t-a', { parent: 'e-m' }),
      task('t-sub', { parent: 't-a' }),
      task('t-other'),
    ];
    const scope = flightScope(tasks[0], childrenByParent(tasks));
    expect(scope.bands).toBeNull();
    expect(scope.nodes.map((t) => t.meta.id)).toEqual(['t-a', 't-b']);
  });

  test('a project bands its milestones by target date, direct tasks last', () => {
    const tasks = [
      task('e-p', { kind: 'project' }),
      task('e-late', {
        kind: 'milestone',
        parent: 'e-p',
        dueDate: '2026-12-01',
      }),
      task('e-soon', {
        kind: 'milestone',
        parent: 'e-p',
        dueDate: '2026-10-01',
      }),
      task('e-undated', { kind: 'milestone', parent: 'e-p' }),
      task('t-1', { parent: 'e-late' }),
      task('t-2', { parent: 'e-soon' }),
      task('t-3', { parent: 'e-p' }),
      // A parent issue is one node; its sub-issue belongs to its own plan.
      task('t-4', { parent: 'e-soon' }),
      task('t-4a', { parent: 't-4' }),
    ];
    const scope = flightScope(tasks[0], childrenByParent(tasks));
    expect(scope.bands?.map((b) => b.key)).toEqual([
      'e-soon',
      'e-late',
      'e-undated',
      DIRECT_BAND,
    ]);
    expect(scope.nodes.map((t) => t.meta.id)).toEqual([
      't-2',
      't-4',
      't-1',
      't-3',
    ]);
    expect(scope.bandOf.get('t-3')).toBe(DIRECT_BAND);
    expect(scope.bandOf.get('t-4')).toBe('e-soon');
  });

  test('a project’s own milestone order wins over target dates', () => {
    const tasks = [
      task('e-p', { kind: 'project' }),
      task('e-first', {
        kind: 'milestone',
        parent: 'e-p',
        dueDate: '2026-12-01',
        sortOrder: -1,
      }),
      task('e-second', {
        kind: 'milestone',
        parent: 'e-p',
        dueDate: '2026-10-01',
        sortOrder: 0.5,
      }),
      // A milestone made here before Linear ordered it sits after the ordered ones.
      task('e-local', {
        kind: 'milestone',
        parent: 'e-p',
        dueDate: '2026-09-01',
      }),
      task('t-1', { parent: 'e-first' }),
      task('t-2', { parent: 'e-second' }),
      task('t-3', { parent: 'e-local' }),
    ];
    const scope = flightScope(tasks[0], childrenByParent(tasks));
    expect(scope.bands?.map((b) => b.key)).toEqual([
      'e-first',
      'e-second',
      'e-local',
    ]);
    expect(scope.nodes.map((t) => t.meta.id)).toEqual(['t-1', 't-2', 't-3']);
  });

  test('an initiative rolls a project’s milestones up into the project’s band', () => {
    const tasks = [
      task('e-i', { kind: 'initiative' }),
      task('e-p', { kind: 'project', parent: 'e-i' }),
      task('e-m', { kind: 'milestone', parent: 'e-p' }),
      task('t-1', { parent: 'e-m' }),
      task('t-2', { parent: 'e-p' }),
    ];
    const scope = flightScope(tasks[0], childrenByParent(tasks));
    expect(scope.bands?.map((b) => b.key)).toEqual(['e-p']);
    expect(scope.nodes.map((t) => t.meta.id).sort()).toEqual(['t-1', 't-2']);
  });

  test('a project without milestones is one plan without bands', () => {
    const tasks = [
      task('e-p', { kind: 'project' }),
      task('t-1', { parent: 'e-p' }),
    ];
    const scope = flightScope(tasks[0], childrenByParent(tasks));
    expect(scope.bands).toBeNull();
    expect(scope.nodes).toHaveLength(1);
  });

  test('a change outside the scope leaves it the same; one inside does not', () => {
    const tasks = [
      task('e-p', { kind: 'project' }),
      task('e-m', { kind: 'milestone', parent: 'e-p' }),
      task('t-1', { parent: 'e-m' }),
      task('t-other'),
    ];
    const before = flightScope(tasks[0], childrenByParent(tasks));
    const elsewhere = [
      ...tasks.slice(0, 3),
      task('t-other', { status: 'landed' }),
    ];
    expect(
      sameScope(before, flightScope(elsewhere[0], childrenByParent(elsewhere)))
    ).toBe(true);
    const inside = [
      ...tasks.slice(0, 2),
      task('t-1', { parent: 'e-m' }),
      tasks[3],
    ];
    expect(
      sameScope(before, flightScope(inside[0], childrenByParent(inside)))
    ).toBe(false);
  });
});
