import { describe, expect, test } from 'bun:test';

import { edgeKey } from './criticalPath';
import {
  cullWindow,
  edgeBounds,
  edgeInWindow,
  nodeInWindow,
  sameWindow,
} from './flightCull';
import { type FlightLayout, NODE_HEIGHT, NODE_WIDTH } from './flightLayout';

const viewport = { left: 2000, top: 1000, width: 1000, height: 600 };

describe('cullWindow', () => {
  test('an unmeasured scroller draws everything', () => {
    expect(cullWindow({ left: 0, top: 0, width: 0, height: 0 }, 32)).toBe(null);
  });

  test('covers the viewport plus a margin, in canvas coordinates', () => {
    const window = cullWindow(viewport, 32);
    if (window === null) throw new Error('no window');
    expect(window.x0).toBeLessThanOrEqual(2000 - 480);
    expect(window.x1).toBeGreaterThanOrEqual(3000 + 480);
    expect(window.y0).toBeLessThanOrEqual(1000 - 32 - 480);
    expect(window.y1).toBeGreaterThanOrEqual(1600 - 32 + 480);
  });

  test('a small scroll inside a tile keeps the same window', () => {
    const a = cullWindow(viewport, 32);
    const b = cullWindow({ ...viewport, top: 1010, left: 2010 }, 32);
    expect(sameWindow(a, b)).toBe(true);
    const far = cullWindow({ ...viewport, top: 3000 }, 32);
    expect(sameWindow(a, far)).toBe(false);
  });
});

describe('node and edge culling', () => {
  const window = { x0: 0, y0: 0, x1: 1000, y1: 1000 };

  test('a card reaching into the window is drawn; one wholly outside is not', () => {
    expect(nodeInWindow(990, 990, window)).toBe(true);
    expect(nodeInWindow(-NODE_WIDTH + 1, 0, window)).toBe(true);
    expect(nodeInWindow(-NODE_WIDTH, 0, window)).toBe(false);
    expect(nodeInWindow(0, 1000, window)).toBe(false);
  });

  test('an edge spanning the window from outside it is drawn', () => {
    const layout = {
      boxes: new Map([
        ['a', { id: 'a', x: -2000, y: 500, wave: 0, column: 0 }],
        ['b', { id: 'b', x: 3000, y: 500, wave: 1, column: 1 }],
        ['c', { id: 'c', x: 3000, y: 5000, wave: 1, column: 1 }],
      ]),
      edges: [
        { from: 'a', to: 'b', d: '' },
        { from: 'b', to: 'c', d: '' },
      ],
    } as unknown as FlightLayout;
    const bounds = edgeBounds(layout);
    expect(bounds.get(edgeKey('a', 'b'))).toEqual({
      x0: -2000,
      y0: 500,
      x1: 3000 + NODE_WIDTH,
      y1: 500 + NODE_HEIGHT,
    });
    expect(edgeInWindow(bounds.get(edgeKey('a', 'b')), window)).toBe(true);
    expect(edgeInWindow(bounds.get(edgeKey('b', 'c')), window)).toBe(false);
    expect(edgeInWindow(undefined, window)).toBe(true);
  });
});
