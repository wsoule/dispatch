import type { TaskDoc, TaskMeta } from '@dispatch/core/browser';
import { defaultTaskFields } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  columnSuccessor,
  groupTasksByLane,
  groupTasksByStatus,
} from './boardGrouping';

function makeTask(
  id: string,
  status: string,
  overrides: Partial<TaskMeta> = {}
): TaskDoc {
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
    ...defaultTaskFields(),
    ...overrides,
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

describe('groupTasksByLane', () => {
  const statuses = ['ready', 'landed'];
  const epic = makeTask('e-1', 'ready', {
    kind: 'milestone',
    title: 'Payments',
  });
  const tasks = [
    epic,
    makeTask('a', 'ready', { parent: 'e-1', priority: 'high' }),
    makeTask('b', 'landed', { assignee: 'agent:claude' }),
  ];

  test('`none` is the one headerless lane the flat board draws', () => {
    const lanes = groupTasksByLane(tasks, statuses, [epic], 'none');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({
      key: 'all',
      kind: 'none',
      epicId: null,
      title: '',
      total: 2,
    });
    expect(lanes[0].columns.map((c) => c.status)).toEqual(statuses);
  });

  test('`epic` delegates to the epic lanes, stamped with their key and kind', () => {
    const lanes = groupTasksByLane(tasks, statuses, [epic], 'epic');
    expect(lanes.map((l) => [l.key, l.kind, l.epicId, l.title])).toEqual([
      ['e-1', 'epic', 'e-1', 'Payments'],
      ['__no-epic__', 'epic', null, 'No epic'],
    ]);
  });

  test('`assignee` and `priority` lane on the task field, epics never becoming cards', () => {
    const byAssignee = groupTasksByLane(tasks, statuses, [epic], 'assignee');
    expect(byAssignee.map((l) => [l.key, l.kind, l.title, l.total])).toEqual([
      ['assignee:agent:claude', 'assignee', 'claude', 1],
      ['assignee:none', 'assignee', 'Unassigned', 1],
    ]);
    const byPriority = groupTasksByLane(tasks, statuses, [epic], 'priority');
    expect(byPriority.map((l) => [l.key, l.kind, l.title, l.total])).toEqual([
      ['priority:high', 'priority', 'High', 1],
      ['priority:none', 'priority', 'No priority', 1],
    ]);
    for (const lane of [...byAssignee, ...byPriority]) {
      expect(lane.epicId).toBeNull();
      for (const column of lane.columns) {
        expect(column.tasks.some((t) => t.meta.kind === 'milestone')).toBe(
          false
        );
      }
    }
  });
});

describe('columnSuccessor', () => {
  const lanes = groupTasksByLane(
    [
      makeTask('a', 'ready'),
      makeTask('b', 'ready'),
      makeTask('c', 'ready'),
      makeTask('w', 'working'),
    ],
    ['ready', 'working'],
    [],
    'none'
  );

  test('the card below takes the place, else the one above, never another column', () => {
    expect(columnSuccessor(lanes, 'a')).toBe('b');
    expect(columnSuccessor(lanes, 'c')).toBe('b');
    expect(columnSuccessor(lanes, 'w')).toBeNull();
  });

  test('a card no lane holds has no successor to name', () => {
    expect(columnSuccessor(lanes, 'gone')).toBeUndefined();
  });
});
