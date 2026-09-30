import type { ClientRect, DroppableContainer } from '@dnd-kit/core';
import { expect, test } from 'bun:test';

import { boardCollision } from './boardCollision';

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }) as ClientRect;

// Two virtual columns: short Draft, very tall Ready (its centre is far below the fold).
const draft = { id: 'lane-0:draft' } as DroppableContainer;
const ready = { id: 'lane-0:ready' } as DroppableContainer;
const rects = new Map([
  [draft.id, rect(0, 44, 348, 3_000)],
  [ready.id, rect(348, 44, 348, 120_000)],
]);

function collide(
  card: ClientRect,
  pointer: { x: number; y: number } | null
): string[] {
  return boardCollision({
    active: { id: 't-1' } as never,
    collisionRect: card,
    droppableRects: rects,
    droppableContainers: [draft, ready],
    pointerCoordinates: pointer,
  }).map((c) => String(c.id));
}

test('a pointer drop lands in the column under the pointer, however tall', () => {
  expect(collide(rect(380, 300, 322, 100), { x: 500, y: 350 })).toEqual([
    'lane-0:ready',
  ]);
});

test('a keyboard drop picks the column spanning the card, nearest across', () => {
  expect(collide(rect(360, 300, 322, 100), null)).toEqual(['lane-0:ready']);
  expect(collide(rect(10, 300, 322, 100), null)).toEqual(['lane-0:draft']);
});

test('a card below every column lands nowhere', () => {
  expect(collide(rect(10, 200_000, 322, 100), null)).toEqual([]);
});
