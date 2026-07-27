import type { TaskDoc } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';

import { groupTasksByEpicLane } from './boardGrouping';

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
