import { describe, expect, test } from 'bun:test';

import {
  BAND_HEADER_HEIGHT,
  flightGeometry,
  flightLayout,
  type FlightLayoutInput,
  flightStructureKey,
  MAX_ROWS,
  NODE_WIDTH,
} from './flightLayout';

function node(
  id: string,
  wave: number,
  blockedBy: string[] = [],
  band: string | null = null
): FlightLayoutInput {
  return {
    id,
    created: `2026-09-01T00:00:0${id.slice(-1)}Z`,
    blockedBy,
    wave,
    band,
  };
}

describe('flightLayout', () => {
  test('waves are columns left to right, edges run from blocker to dependent', () => {
    const layout = flightLayout(
      [node('a', 0), node('b', 0), node('c', 1, ['a', 'b'])],
      null
    );
    const a = layout.boxes.get('a');
    const b = layout.boxes.get('b');
    const c = layout.boxes.get('c');
    expect(a.x).toBe(b.x);
    expect(c.x).toBeGreaterThan(a.x + NODE_WIDTH);
    expect(a.y).toBeLessThan(b.y);
    expect(layout.columns.map((col) => col.wave)).toEqual([0, 1]);
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      'a>c',
      'b>c',
    ]);
    // The edge leaves a's right side and enters c's left side.
    expect(layout.edges[0]?.d.startsWith(`M ${a.x + NODE_WIDTH} `)).toBe(true);
    expect(layout.width).toBeGreaterThan(c.x + NODE_WIDTH);
  });

  test('a node sits level with its blockers when it can', () => {
    const layout = flightLayout(
      [node('a', 0), node('b', 0), node('d', 1, ['b']), node('c', 1, ['a'])],
      null
    );
    expect(layout.boxes.get('c').y).toBe(layout.boxes.get('a').y);
    expect(layout.boxes.get('d').y).toBe(layout.boxes.get('b').y);
  });

  test('a crowded wave wraps into sub-columns', () => {
    const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) =>
      node(`n${String(i).padStart(2, '0')}`, 0)
    );
    const layout = flightLayout(many, null);
    const xs = new Set([...layout.boxes.values()].map((b) => b.x));
    expect(xs.size).toBe(2);
    expect(new Set([...layout.boxes.values()].map((b) => b.column))).toEqual(
      new Set([0, 1])
    );
    expect(layout.columns[0]?.width).toBeGreaterThan(NODE_WIDTH * 2);
  });

  test('bands stack top to bottom, each under its header, sharing the wave columns', () => {
    const layout = flightLayout(
      [
        node('a', 0, [], 'm1'),
        node('b', 1, ['a'], 'm2'),
        node('c', 0, [], 'm2'),
      ],
      ['m1', 'm2']
    );
    const [m1, m2] = layout.bands;
    expect(m1?.key).toBe('m1');
    expect(m2.top).toBeGreaterThan(m1.top + m1.height);
    expect(layout.boxes.get('a').y).toBe(m1.top + BAND_HEADER_HEIGHT);
    expect(layout.boxes.get('c').x).toBe(layout.boxes.get('a').x);
    expect(layout.boxes.get('b').y).toBeGreaterThanOrEqual(
      m2.top + BAND_HEADER_HEIGHT
    );
  });

  test('the same structure lays out identically, whatever the input order', () => {
    const nodes = [node('a', 0), node('b', 0), node('c', 1, ['a'])];
    const one = flightLayout(nodes, null);
    const two = flightLayout([...nodes].reverse(), null);
    for (const id of ['a', 'b', 'c']) {
      expect(two.boxes.get(id)).toEqual(one.boxes.get(id));
    }
  });

  test('the structure key sees what the layout reads, and geometry reads it back', () => {
    const base = [
      { id: 'a', created: '1', blockedBy: [], band: null },
      { id: 'b', created: '2', blockedBy: ['a'], band: null },
    ];
    const key = flightStructureKey(base, null);
    expect(key).toBe(flightStructureKey([...base], null));
    expect(key).not.toBe(
      flightStructureKey([base[0], { ...base[1], blockedBy: [] }], null)
    );
    expect(key).not.toBe(flightStructureKey(base, []));
    const { waves, layout } = flightGeometry(key);
    expect([...waves]).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b']);
  });
});
