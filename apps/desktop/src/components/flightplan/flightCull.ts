import { edgeKey } from './criticalPath';
import { type FlightLayout, NODE_HEIGHT, NODE_WIDTH } from './flightLayout';

// Off-screen culling for the full Flight Plan: a plan of hundreds of nodes draws only the
// cards and edges near the scrolled viewport. Pure, so the geometry is testable without a
// layout engine.

/** The part of the canvas worth drawing, in canvas coordinates. */
export interface CullWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ScrollRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Drawn beyond the viewport on every side, so a scroll finds its nodes already there. */
const CULL_MARGIN = 480;
/** The window snaps outward to this grid, so scrolling re-culls only on crossing a tile. */
const CULL_TILE = 240;

/** The window for a scroller at `rect`, whose canvas starts `offsetTop` into its content;
 * null (draw everything) while the scroller has not been laid out. */
export function cullWindow(
  rect: ScrollRect,
  offsetTop: number
): CullWindow | null {
  if (rect.width === 0 && rect.height === 0) return null;
  const down = (v: number) => Math.floor(v / CULL_TILE) * CULL_TILE;
  const up = (v: number) => Math.ceil(v / CULL_TILE) * CULL_TILE;
  const top = rect.top - offsetTop;
  return {
    x0: down(rect.left - CULL_MARGIN),
    y0: down(top - CULL_MARGIN),
    x1: up(rect.left + rect.width + CULL_MARGIN),
    y1: up(top + rect.height + CULL_MARGIN),
  };
}

export function sameWindow(
  a: CullWindow | null,
  b: CullWindow | null
): boolean {
  if (a === null || b === null) return a === b;
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

function overlaps(box: Box, window: CullWindow): boolean {
  return (
    box.x0 < window.x1 &&
    box.x1 > window.x0 &&
    box.y0 < window.y1 &&
    box.y1 > window.y0
  );
}

/** Whether a node card at (`x`, `y`) reaches into the window. */
export function nodeInWindow(
  x: number,
  y: number,
  window: CullWindow
): boolean {
  return overlaps(
    { x0: x, y0: y, x1: x + NODE_WIDTH, y1: y + NODE_HEIGHT },
    window
  );
}

/** Each edge's bounds by edge key: the union of its two cards, which its curve stays in. */
export function edgeBounds(layout: FlightLayout): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const edge of layout.edges) {
    const from = layout.boxes.get(edge.from);
    const to = layout.boxes.get(edge.to);
    if (from === undefined || to === undefined) continue;
    out.set(edgeKey(edge.from, edge.to), {
      x0: Math.min(from.x, to.x),
      y0: Math.min(from.y, to.y),
      x1: Math.max(from.x, to.x) + NODE_WIDTH,
      y1: Math.max(from.y, to.y) + NODE_HEIGHT,
    });
  }
  return out;
}

/** Whether an edge with `bounds` reaches into the window; an edge without bounds is kept. */
export function edgeInWindow(
  bounds: Box | undefined,
  window: CullWindow
): boolean {
  return bounds === undefined || overlaps(bounds, window);
}
