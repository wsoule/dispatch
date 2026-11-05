import { describe, expect, test } from 'bun:test';

import { basisPath, routeAround } from '../src/graph/layout';

// Arrows between frames are rerouted round the boxes in their way: on
// the showcase's 406-box issue level 67 of 247 arrows ran behind some
// box that was not one of their ends (2026-10-23 review), and the
// default /graph landing showed 25 of 54 doing so, so a reader could not
// tell where an arrow ended.

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** Points along the drawn curve of `points` (basisPath's M, L and C). */
function curve(points: readonly Point[]): Point[] {
  const tokens = basisPath(points).match(/[MLC]|-?\d*\.?\d+/g) ?? [];
  const out: Point[] = [];
  let i = 0;
  let at = { x: 0, y: 0 };
  const next = () => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') {
      at = next();
      out.push(at);
    } else if (command === 'L') {
      const to = next();
      for (let k = 1; k <= 20; k += 1) {
        out.push({
          x: at.x + ((to.x - at.x) * k) / 20,
          y: at.y + ((to.y - at.y) * k) / 20,
        });
      }
      at = to;
    } else {
      const [c1, c2, to] = [next(), next(), next()];
      for (let k = 1; k <= 32; k += 1) {
        const t = k / 32;
        const u = 1 - t;
        out.push({
          x:
            u ** 3 * at.x +
            3 * u * u * t * c1.x +
            3 * u * t * t * c2.x +
            t ** 3 * to.x,
          y:
            u ** 3 * at.y +
            3 * u * u * t * c1.y +
            3 * u * t * t * c2.y +
            t ** 3 * to.y,
        });
      }
      at = to;
    }
  }
  return out;
}

/** Whether the drawn curve of `points` runs inside `box` anywhere. */
function runsBehind(points: readonly Point[], box: Box): boolean {
  return curve(points).some(
    (p) =>
      p.x > box.x &&
      p.x < box.x + box.width &&
      p.y > box.y &&
      p.y < box.y + box.height
  );
}

// An arrow between frames: its box's side, its straight lead, the lead
// into the waiting box, the waiting box's side.
const ARROW: Point[] = [
  { x: 0, y: 50 },
  { x: 28, y: 50 },
  { x: 472, y: 50 },
  { x: 500, y: 50 },
];

describe('routeAround: arrows keep clear of the boxes in their way', () => {
  test('a run through a box turns round it by its nearer side', () => {
    const box = { x: 200, y: 30, width: 100, height: 60 };
    expect(runsBehind(ARROW, box)).toBe(true);
    const routed = routeAround(ARROW, [box], [], true);
    expect(runsBehind(routed, box)).toBe(false);
    // Over the box (the run passes above its centre), 6px out from it.
    expect(routed.some((p) => p.y === 24)).toBe(true);
    expect(routed.every((p) => p.y <= 50)).toBe(true);
    // Its ends and straight leads are kept.
    expect(routed.slice(0, 2)).toEqual(ARROW.slice(0, 2));
    expect(routed.slice(-2)).toEqual(ARROW.slice(-2));
  });

  test('a clear run, and the arrow’s own boxes, leave it straight', () => {
    const own = { x: -100, y: 20, width: 100, height: 60 };
    const routed = routeAround(ARROW, [own], [own], true);
    expect(curve(routed).every((p) => Math.abs(p.y - 50) < 0.01)).toBe(true);
  });

  test('a long diagonal run threads a grid of boxes through its gaps', () => {
    // Five rows of five 120 x 44 boxes, 16px apart across, 12px down,
    // as a frame's grid of loose boxes is packed.
    const grid: Box[] = [];
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        grid.push({
          x: 100 + col * 136,
          y: 100 + row * 56,
          width: 120,
          height: 44,
        });
      }
    }
    const diagonal: Point[] = [
      { x: 0, y: 0 },
      { x: 28, y: 20 },
      { x: 860, y: 460 },
      { x: 888, y: 480 },
    ];
    expect(
      grid.filter((box) => runsBehind(diagonal, box)).length
    ).toBeGreaterThan(3);
    const routed = routeAround(diagonal, grid, [], true);
    expect(grid.filter((box) => runsBehind(routed, box))).toEqual([]);
    expect(routed[0]).toEqual(diagonal[0]);
    expect(routed.at(-1)).toEqual(diagonal.at(-1));
  });

  test('without leads, the first and last runs turn round boxes too', () => {
    const box = { x: 40, y: 30, width: 60, height: 60 };
    const route: Point[] = [
      { x: 0, y: 50 },
      { x: 250, y: 50 },
      { x: 500, y: 50 },
    ];
    expect(runsBehind(route, box)).toBe(true);
    const routed = routeAround(route, [box], [], false);
    expect(runsBehind(routed, box)).toBe(false);
    expect(routed[0]).toEqual(route[0]);
    expect(routed.at(-1)).toEqual(route[2]);
  });
});
