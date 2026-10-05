import type { TaskDoc } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  countLaneStatuses,
  dropZoneId,
  groupTasksByEpicLane,
  groupTasksByLane,
  laneKey,
  statusFromDropZoneId,
  visibleBoardColumns,
  visibleLaneTaskIds,
} from './boardGrouping';

function task(
  id: string,
  status: string,
  parent: string | null = null,
  kind = 'task',
  extra: { assignee?: string; priority?: string } = {}
): TaskDoc {
  return {
    meta: {
      id,
      title: id,
      status,
      parent,
      kind,
      assignee: extra.assignee ?? 'none',
      priority: extra.priority ?? 'none',
    },
  } as TaskDoc;
}

const STATUSES = ['todo', 'in-progress', 'done'];

describe('groupTasksByEpicLane', () => {
  test('one lane per epic, each with the full status column set', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'todo', 'e-1'), task('t-2', 'done', 'e-2')],
      STATUSES,
      [task('e-1', 'todo', null, 'epic'), task('e-2', 'todo', null, 'epic')]
    );
    expect(lanes.map((l) => l.epicId)).toEqual(['e-1', 'e-2']);
    expect(lanes[0]?.columns.map((c) => c.status)).toEqual(STATUSES);
  });

  // The status columns are the project's own, so a custom tracker is not reduced to a fixed set.
  test('columns follow the configured status order, not an alphabetical or fixed one', () => {
    const custom = ['icebox', 'shipping', 'landed'];
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'shipping', 'e-1')],
      custom,
      [task('e-1', 'todo', null, 'epic')]
    );
    expect(lanes[0]?.columns.map((c) => c.status)).toEqual(custom);
  });

  test('lanes follow the project epic order', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'todo', 'e-2'), task('t-2', 'todo', 'e-1')],
      STATUSES,
      [task('e-2', 'todo', null, 'epic'), task('e-1', 'todo', null, 'epic')]
    );
    expect(lanes.map((l) => l.epicId)).toEqual(['e-2', 'e-1']);
  });

  // Twenty epics with three active ones must not render seventeen blank rows.
  test('an epic with no tasks gets no lane', () => {
    const lanes = groupTasksByEpicLane([task('t-1', 'todo', 'e-1')], STATUSES, [
      task('e-1', 'todo', null, 'epic'),
      task('e-empty', 'todo', null, 'epic'),
    ]);
    expect(lanes.map((l) => l.epicId)).toEqual(['e-1']);
  });

  test('parentless tasks land in a no-epic lane, last', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'todo', 'e-1'), task('t-loose', 'todo')],
      STATUSES,
      [task('e-1', 'todo', null, 'epic')]
    );
    expect(lanes.at(-1)?.epicId).toBeNull();
    expect(lanes.at(-1)?.title).toBe('No epic');
  });

  // A dangling parent must not masquerade as unparented — that hides a real data problem.
  test('a parent that resolves to no known epic gets its own lane', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'todo', 'e-ghost')],
      STATUSES,
      []
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.epicId).toBe('e-ghost');
  });

  // An epic is a lane heading; counting it as a card inside its own lane would double it.
  test('epics are lane headings, never cards', () => {
    const lanes = groupTasksByEpicLane(
      [task('e-1', 'todo', null, 'epic'), task('t-1', 'todo', 'e-1')],
      STATUSES,
      [task('e-1', 'todo', null, 'epic')]
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.total).toBe(1);
  });

  test('lane totals match the cards placed in them', () => {
    const lanes = groupTasksByEpicLane(
      [
        task('t-1', 'todo', 'e-1'),
        task('t-2', 'done', 'e-1'),
        task('t-3', 'in-progress', 'e-1'),
      ],
      STATUSES,
      [task('e-1', 'todo', null, 'epic')]
    );
    const placed = lanes[0]?.columns.reduce((n, c) => n + c.tasks.length, 0);
    expect(placed).toBe(lanes[0]?.total);
    expect(placed).toBe(3);
  });

  test('an empty project produces no lanes', () => {
    expect(groupTasksByEpicLane([], STATUSES, [])).toEqual([]);
  });

  // The header count and the visible cards must agree, or the board lies about its own contents.
  test('the lane total counts rendered cards, not bucket size', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'nonsense', 'e-1'), task('t-2', 'todo', 'e-1')],
      STATUSES,
      [task('e-1', 'todo', null, 'epic')]
    );
    expect(lanes[0]?.total).toBe(1);
  });

  test('a lane emptied entirely by the status filter is not rendered', () => {
    expect(
      groupTasksByEpicLane([task('t-1', 'nonsense', 'e-1')], STATUSES, [
        task('e-1', 'todo', null, 'epic'),
      ])
    ).toEqual([]);
  });

  test('a task whose status is not configured is dropped, as on the flat board', () => {
    const lanes = groupTasksByEpicLane(
      [task('t-1', 'nonsense', 'e-1'), task('t-2', 'todo', 'e-1')],
      STATUSES,
      [task('e-1', 'todo', null, 'epic')]
    );
    const placed = lanes[0]?.columns.reduce((n, c) => n + c.tasks.length, 0);
    expect(placed).toBe(1);
  });
});

const TWO_EPIC_LANES = groupTasksByEpicLane(
  [
    task('t-1', 'todo', 'e-1'),
    task('t-2', 'todo', 'e-1'),
    task('t-3', 'done', 'e-1'),
    task('t-4', 'todo', 'e-2'),
    task('t-loose', 'done'),
  ],
  STATUSES,
  [task('e-1', 'todo', null, 'epic'), task('e-2', 'todo', null, 'epic')]
);

describe('laneKey', () => {
  test('an epic lane is keyed by its epic id', () => {
    expect(laneKey('e-1')).toBe('e-1');
    expect(TWO_EPIC_LANES.map((lane) => lane.key)).toEqual([
      'e-1',
      'e-2',
      laneKey(null),
    ]);
  });

  test('the no-epic lane gets a sentinel no epic id can collide with', () => {
    expect(laneKey(null)).not.toBe('');
    expect(laneKey(null)).not.toMatch(/^e-/);
  });
});

describe('groupTasksByLane: assignee', () => {
  const lanes = groupTasksByLane(
    [
      task('t-1', 'todo', null, 'task', { assignee: 'human:wyat' }),
      task('t-2', 'done', null, 'task'),
      task('t-3', 'todo', null, 'task', { assignee: 'agent:claude' }),
      task('t-4', 'todo', null, 'task', { assignee: 'human:alice' }),
      task('e-1', 'todo', null, 'epic', { assignee: 'agent:claude' }),
    ],
    STATUSES,
    [task('e-1', 'todo', null, 'epic')],
    'assignee'
  );

  // The list's rank: agents first, people by handle, then the unassigned catch-all.
  test('agents lead, people follow by handle, Unassigned is last', () => {
    expect(lanes.map((l) => l.title)).toEqual([
      'claude',
      'alice',
      'wyat',
      'Unassigned',
    ]);
  });

  test('keys are namespaced by the raw assignee value, which the lane also carries', () => {
    expect(lanes.map((l) => l.key)).toEqual([
      'assignee:agent:claude',
      'assignee:human:alice',
      'assignee:human:wyat',
      'assignee:none',
    ]);
    expect(lanes.map((l) => l.value)).toEqual([
      'agent:claude',
      'human:alice',
      'human:wyat',
      'none',
    ]);
    expect(lanes.every((l) => l.kind === 'assignee' && l.epicId === null)).toBe(
      true
    );
  });

  test('every lane carries the full status column set', () => {
    for (const lane of lanes) {
      expect(lane.columns.map((c) => c.status)).toEqual(STATUSES);
    }
  });

  // An epic heads its own lane on the epic board and belongs on no other.
  test('epics never become cards', () => {
    expect(lanes.find((l) => l.key === 'assignee:agent:claude')?.total).toBe(1);
    expect(visibleLaneTaskIds(lanes, new Set())).not.toContain('e-1');
  });
});

describe('groupTasksByLane: priority', () => {
  const lanes = groupTasksByLane(
    [
      task('t-1', 'todo', null, 'task', { priority: 'low' }),
      task('t-2', 'done', null, 'task', { priority: 'urgent' }),
      task('t-3', 'todo', null, 'task', { priority: 'urgent' }),
      task('t-4', 'todo', null, 'task'),
    ],
    STATUSES,
    [],
    'priority'
  );

  test('lanes follow PRIORITY_ORDER with the empty priorities dropped', () => {
    expect(lanes.map((l) => [l.key, l.value, l.title, l.total])).toEqual([
      ['priority:urgent', 'urgent', 'Urgent', 2],
      ['priority:low', 'low', 'Low', 1],
      ['priority:none', 'none', 'No priority', 1],
    ]);
  });

  test('a lane the status filter empties is dropped', () => {
    const filtered = groupTasksByLane(
      [task('t-1', 'nonsense', null, 'task', { priority: 'high' })],
      STATUSES,
      [],
      'priority'
    );
    expect(filtered).toEqual([]);
  });
});

describe('countLaneStatuses', () => {
  test("sums every lane's cards per status", () => {
    const counts = countLaneStatuses(TWO_EPIC_LANES, STATUSES);
    expect(counts.get('todo')).toBe(3);
    expect(counts.get('done')).toBe(2);
    expect(counts.get('in-progress')).toBe(0);
  });

  test('every configured status gets an entry, even one no task is in', () => {
    const counts = countLaneStatuses(TWO_EPIC_LANES, STATUSES);
    expect([...counts.keys()]).toEqual(STATUSES);
  });
});

describe('visibleBoardColumns', () => {
  const counts = new Map([
    ['todo', 3],
    ['in-progress', 0],
    ['done', 2],
  ]);

  test('drops empty statuses unless empty groups are shown', () => {
    expect(visibleBoardColumns(STATUSES, counts, false)).toEqual([
      'todo',
      'done',
    ]);
    expect(visibleBoardColumns(STATUSES, counts, true)).toEqual(STATUSES);
  });

  test('a hidden column stays hidden even with empty groups on', () => {
    expect(
      visibleBoardColumns(STATUSES, counts, true, new Set(['done']))
    ).toEqual(['todo', 'in-progress']);
  });

  test('keeps the configured order', () => {
    expect(visibleBoardColumns(['done', 'todo'], counts, false)).toEqual([
      'done',
      'todo',
    ]);
  });
});

describe('visibleLaneTaskIds', () => {
  // Lane by lane, then column-major inside a lane — the order the eye reads the board in.
  test('walks lanes in order, then down each status column', () => {
    expect(visibleLaneTaskIds(TWO_EPIC_LANES, new Set())).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
      't-loose',
    ]);
  });

  // The regression this guards: j/k landing on a card inside a folded-up lane, which moves real
  // DOM focus to something nobody can see and leaves Enter opening an invisible task.
  test('skips the cards a collapsed lane is hiding', () => {
    expect(visibleLaneTaskIds(TWO_EPIC_LANES, new Set(['e-1']))).toEqual([
      't-4',
      't-loose',
    ]);
  });

  test('everything collapsed leaves nothing to traverse', () => {
    const all = new Set(TWO_EPIC_LANES.map((lane) => lane.key));
    expect(visibleLaneTaskIds(TWO_EPIC_LANES, all)).toEqual([]);
  });

  // Lanes of every kind fold by `lane.key`, so a priority lane's fold hides its cards too.
  test('a collapsed priority lane is skipped by its own key', () => {
    const lanes = groupTasksByLane(
      [
        task('t-1', 'todo', null, 'task', { priority: 'urgent' }),
        task('t-2', 'todo', null, 'task', { priority: 'low' }),
      ],
      STATUSES,
      [],
      'priority'
    );
    expect(visibleLaneTaskIds(lanes, new Set(['priority:urgent']))).toEqual([
      't-2',
    ]);
  });
});

describe('drop zone ids', () => {
  // Every lane repeats the same statuses, and @dnd-kit keys its droppables by id — identical
  // ids would leave one lane per status as the only real drop target.
  test('the same status in two lanes gets two different ids', () => {
    expect(dropZoneId(0, 'todo')).not.toBe(dropZoneId(1, 'todo'));
  });

  test('the status survives the round trip', () => {
    expect(statusFromDropZoneId(dropZoneId(3, 'in-progress'))).toBe(
      'in-progress'
    );
  });

  test('a status containing a colon still round-trips', () => {
    expect(statusFromDropZoneId(dropZoneId(12, 'qa:blocked'))).toBe(
      'qa:blocked'
    );
  });

  test.each(['todo', 'lane:', 'lane:0', 'lane:0:', ''])(
    'an id that is not a drop zone (%p) resolves to no status',
    (id) => {
      expect(statusFromDropZoneId(id)).toBeNull();
    }
  );
});
