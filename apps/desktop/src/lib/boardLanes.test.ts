import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  countLaneStatuses,
  dropZoneId,
  groupTasksByEpicLane,
  laneKey,
  statusFromDropZoneId,
  visibleLaneTaskIds,
} from './boardGrouping';

function task(
  id: string,
  status: string,
  parent: string | null = null,
  kind = 'task'
): TaskDoc {
  return { meta: { id, title: id, status, parent, kind } } as TaskDoc;
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
  });

  test('the no-epic lane gets a sentinel no epic id can collide with', () => {
    expect(laneKey(null)).not.toBe('');
    expect(laneKey(null)).not.toMatch(/^e-/);
  });
});

describe('countLaneStatuses', () => {
  test('with nothing collapsed every card is counted as visible', () => {
    const counts = countLaneStatuses(TWO_EPIC_LANES, STATUSES, new Set());
    expect(counts.get('todo')).toEqual({ visible: 3, hidden: 0 });
    expect(counts.get('done')).toEqual({ visible: 2, hidden: 0 });
    expect(counts.get('in-progress')).toEqual({ visible: 0, hidden: 0 });
  });

  // The point of the split: a collapsed epic's cards move from one column of the header count
  // to the other, so the totals never quietly shrink.
  test('a collapsed lane moves its cards from visible to hidden, status by status', () => {
    const counts = countLaneStatuses(
      TWO_EPIC_LANES,
      STATUSES,
      new Set(['e-1'])
    );
    expect(counts.get('todo')).toEqual({ visible: 1, hidden: 2 });
    expect(counts.get('done')).toEqual({ visible: 1, hidden: 1 });
  });

  test('the no-epic lane collapses under its sentinel key like any other', () => {
    const counts = countLaneStatuses(
      TWO_EPIC_LANES,
      STATUSES,
      new Set([laneKey(null)])
    );
    expect(counts.get('done')).toEqual({ visible: 1, hidden: 1 });
  });

  test('every configured status gets an entry, even one no task is in', () => {
    const counts = countLaneStatuses(TWO_EPIC_LANES, STATUSES, new Set());
    expect([...counts.keys()]).toEqual(STATUSES);
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
    const all = new Set(TWO_EPIC_LANES.map((lane) => laneKey(lane.epicId)));
    expect(visibleLaneTaskIds(TWO_EPIC_LANES, all)).toEqual([]);
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
