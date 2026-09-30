import { type CollisionDetection, pointerWithin } from '@dnd-kit/core';

// Which column a card is over: the one under the pointer, else (a keyboard drag has no
// pointer) the column whose vertical span holds the card's centre, nearest horizontally.
// Never `closestCenter`: a virtual column is as tall as all its cards, so its centre can
// sit thousands of pixels from where the card is.
export const boardCollision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  if (under.length > 0) return under;
  const { collisionRect, droppableRects, droppableContainers } = args;
  const x = collisionRect.left + collisionRect.width / 2;
  const y = collisionRect.top + collisionRect.height / 2;
  let best: {
    container: (typeof droppableContainers)[number];
    distance: number;
  } | null = null;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (rect === undefined || y < rect.top || y > rect.bottom) continue;
    const distance = Math.abs(rect.left + rect.width / 2 - x);
    if (best === null || distance < best.distance) {
      best = { container, distance };
    }
  }
  return best === null
    ? []
    : [
        {
          id: best.container.id,
          data: { droppableContainer: best.container, value: best.distance },
        },
      ];
};
