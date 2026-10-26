import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TASKS_DISPLAY,
  type TaskProperty,
  type TasksDisplayPrefs,
  type TasksGrouping,
} from '../lib/tasksPrefs';
import { COLUMN_LABELS, columnsForPrefs, DEFAULT_COLUMNS } from './columns';

function prefs(
  properties: readonly TaskProperty[],
  over: Partial<Omit<TasksDisplayPrefs, 'properties'>> = {}
): TasksDisplayPrefs {
  return { ...DEFAULT_TASKS_DISPLAY, ...over, properties: new Set(properties) };
}

const EVERYTHING: readonly TaskProperty[] = [
  'id',
  'status',
  'assignee',
  'priority',
  'epic',
  'milestone',
  'labels',
  'links',
  'created',
  'updated',
  'run',
];

describe('columnsForPrefs', () => {
  test('the default display model shows the hierarchy, the workflow facts, who and when', () => {
    expect(columnsForPrefs(DEFAULT_TASKS_DISPLAY)).toEqual([
      'project',
      'milestone',
      'state',
      'priority',
      'assignee',
      'due',
    ]);
    expect(DEFAULT_COLUMNS).toEqual(columnsForPrefs(DEFAULT_TASKS_DISPLAY));
  });

  test('every property on gives every column once, in the table order', () => {
    expect(columnsForPrefs(prefs(EVERYTHING))).toEqual([
      'project',
      'milestone',
      'state',
      'priority',
      'assignee',
      'due',
    ]);
  });

  test('no property gives no meta column (the key and title stay)', () => {
    expect(columnsForPrefs(prefs([]))).toEqual([]);
    expect(columnsForPrefs(prefs(['id', 'labels', 'links', 'run']))).toEqual(
      []
    );
  });

  test('status, priority and assignee each follow their own toggle', () => {
    expect(columnsForPrefs(prefs(['status']))).toEqual(['state']);
    expect(columnsForPrefs(prefs(['priority']))).toEqual(['priority']);
    expect(columnsForPrefs(prefs(['assignee']))).toEqual(['assignee']);
    expect(columnsForPrefs(prefs(['assignee', 'status', 'priority']))).toEqual([
      'state',
      'priority',
      'assignee',
    ]);
  });

  test('either hierarchy toggle (Epic, Milestone) shows the project and milestone columns', () => {
    expect(columnsForPrefs(prefs(['epic']))).toEqual(['project', 'milestone']);
    expect(columnsForPrefs(prefs(['milestone']))).toEqual([
      'project',
      'milestone',
    ]);
    expect(columnsForPrefs(prefs(['epic', 'milestone']))).toEqual([
      'project',
      'milestone',
    ]);
  });

  test('either date toggle shows the one due column', () => {
    expect(columnsForPrefs(prefs(['created']))).toEqual(['due']);
    expect(columnsForPrefs(prefs(['updated']))).toEqual(['due']);
    expect(columnsForPrefs(prefs(['created', 'updated']))).toEqual(['due']);
  });

  test('grouping by a container drops the hierarchy columns its headers already name', () => {
    for (const grouping of ['epic', 'milestone'] as const) {
      expect(columnsForPrefs(prefs(EVERYTHING, { grouping }))).toEqual([
        'state',
        'priority',
        'assignee',
        'due',
      ]);
    }
  });

  test('a grouping by status, assignee or priority keeps that column: its cell is the inline picker', () => {
    const groupings: TasksGrouping[] = [
      'status',
      'assignee',
      'priority',
      'none',
    ];
    for (const grouping of groupings) {
      expect(columnsForPrefs(prefs(EVERYTHING, { grouping }))).toEqual([
        'project',
        'milestone',
        'state',
        'priority',
        'assignee',
        'due',
      ]);
    }
  });

  test('an explicit grouping argument wins over the prefs grouping (the board asks per lane)', () => {
    const byStatus = prefs(EVERYTHING, { grouping: 'status' });
    expect(columnsForPrefs(byStatus, 'epic')).toEqual([
      'state',
      'priority',
      'assignee',
      'due',
    ]);
    const byEpic = prefs(['epic'], { grouping: 'epic' });
    expect(columnsForPrefs(byEpic, 'status')).toEqual(['project', 'milestone']);
  });
});

describe('COLUMN_LABELS', () => {
  test('only the state header changes, to Dispatch\'s "Status"', () => {
    expect(COLUMN_LABELS).toEqual({ state: 'Status' });
  });
});
