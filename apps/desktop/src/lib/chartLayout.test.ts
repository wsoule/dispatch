import { describe, expect, test } from 'bun:test';

import {
  type ChartLayout,
  type ChartSpec,
  EMPTY_LAYOUT,
  layoutChart,
  type PlacedBox,
  type Point,
  roundedPath,
} from './chartLayout';

// Every fixture node is the same size as a chart card; the layout never reads anything else.
function node(id: string, group?: string | null) {
  return { id, width: 160, height: 48, group };
}

function edge(from: string, to: string, id = `${from}>${to}`) {
  return { id, from, to };
}

function boxOf(layout: ChartLayout, id: string): PlacedBox {
  const box = layout.nodes.get(id);
  if (box === undefined) throw new Error(`no box for ${id}`);
  return box;
}

// True when `p` sits on the outline of `box`, within `tolerance` pixels.
function onBoundary(p: Point, box: PlacedBox, tolerance = 1): boolean {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const inside =
    p.x >= left - tolerance &&
    p.x <= right + tolerance &&
    p.y >= top - tolerance &&
    p.y <= bottom + tolerance;
  const nearSide =
    Math.min(
      Math.abs(p.x - left),
      Math.abs(p.x - right),
      Math.abs(p.y - top),
      Math.abs(p.y - bottom)
    ) <= tolerance;
  return inside && nearSide;
}

// Each box in `ids` starts right of the previous one's right edge.
function expectLeftToRight(layout: ChartLayout, ids: readonly string[]): void {
  for (let i = 1; i < ids.length; i++) {
    const before = boxOf(layout, ids[i - 1]);
    expect(boxOf(layout, ids[i]).x).toBeGreaterThan(before.x + before.width);
  }
}

function contains(outer: PlacedBox, inner: PlacedBox): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

// Every route: at least two points, each segment exactly horizontal or vertical, both ends
// on their boxes' outlines, and the count label at the middle of the longest segment.
function expectSoundRoutes(layout: ChartLayout): void {
  for (const e of layout.edges) {
    expect(e.points.length).toBeGreaterThanOrEqual(2);
    let longest = -1;
    let middle: Point = e.points[0];
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1];
      const b = e.points[i];
      expect({
        edge: e.id,
        segment: i,
        square: a.x === b.x || a.y === b.y,
      }).toEqual({
        edge: e.id,
        segment: i,
        square: true,
      });
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > longest) {
        longest = length;
        middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    }
    expect({ edge: e.id, labelAt: e.labelAt }).toEqual({
      edge: e.id,
      labelAt: middle,
    });
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    expect({
      edge: e.id,
      onSource: onBoundary(first, boxOf(layout, e.from)),
    }).toEqual({
      edge: e.id,
      onSource: true,
    });
    expect({
      edge: e.id,
      onTarget: onBoundary(last, boxOf(layout, e.to)),
    }).toEqual({
      edge: e.id,
      onTarget: true,
    });
  }
}

// Mulberry32: a tiny seeded generator, so the random graphs are the same on every run.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two groups, a loose node either side, and an edge of every kind: inside one group,
// group to group, group to root, and root to group.
const GROUPED: ChartSpec = {
  nodes: [
    node('start'),
    node('a', 'g1'),
    node('a2', 'g1'),
    node('b', 'g2'),
    node('b2', 'g2'),
    node('end'),
  ],
  edges: [
    edge('start', 'a'),
    edge('a', 'a2'),
    edge('a', 'b'),
    edge('a2', 'b2'),
    edge('b', 'b2'),
    edge('b2', 'end'),
  ],
  groups: [
    { id: 'g1', label: 'Milestone one' },
    { id: 'g2', label: 'Milestone two' },
  ],
};

// Odd box heights put ELK's ports on fractional rows, and it joins each cross-group route at
// the group border with a sub-pixel jog (a>c drifts by 1/3px leaving `a` and 1/2px entering
// g2), which `layoutChart` has to square away.
const ODD_HEIGHTS: ChartSpec = {
  nodes: [
    { id: 'a', width: 160, height: 47, group: 'g1' },
    { id: 'b', width: 160, height: 48, group: 'g1' },
    { id: 'c', width: 160, height: 61, group: 'g2' },
    { id: 'd', width: 160, height: 48, group: 'g2' },
  ],
  edges: [edge('a', 'c'), edge('b', 'd'), edge('a', 'd')],
  groups: [
    { id: 'g1', label: 'One' },
    { id: 'g2', label: 'Two' },
  ],
};

const THREE_GROUPS = [
  { id: 'g1', label: 'One' },
  { id: 'g2', label: 'Two' },
  { id: 'g3', label: 'Three' },
];

describe('layoutChart', () => {
  test('an empty spec resolves to EMPTY_LAYOUT', async () => {
    expect(await layoutChart({ nodes: [], edges: [] })).toBe(EMPTY_LAYOUT);
    expect(
      await layoutChart({ nodes: [], edges: [edge('x', 'y')], groups: [] })
    ).toBe(EMPTY_LAYOUT);
  });

  test('a chain reads left to right', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const layout = await layoutChart({
      nodes: ids.map((id) => node(id)),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
    });
    expectLeftToRight(layout, ids);
    expect([...layout.nodes.keys()]).toEqual(ids);
    expect(layout.groups).toEqual([]);
  });

  test('every box fits inside the reported size', async () => {
    const layout = await layoutChart(GROUPED);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    const boxes: PlacedBox[] = [...layout.nodes.values(), ...layout.groups];
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  test('edges are square polylines with the label on the longest segment', async () => {
    for (const spec of [GROUPED, ODD_HEIGHTS]) {
      const layout = await layoutChart(spec);
      expect(layout.edges.map((e) => e.id)).toEqual(
        spec.edges.map((e) => e.id)
      );
      expectSoundRoutes(layout);
    }
  });

  test('edge endpoints touch their boxes in root coordinates, across groups too', async () => {
    const layout = await layoutChart(GROUPED);
    expectSoundRoutes(layout);
    // Left to right: a dependency leaves its source's right side for its target's left.
    const cross = layout.edges.find((e) => e.id === 'a>b');
    expect(cross).toBeDefined();
    if (cross === undefined) return;
    const a = boxOf(layout, 'a');
    const b = boxOf(layout, 'b');
    expect(cross.points[0].x).toBeCloseTo(a.x + a.width, 0);
    expect(cross.points[cross.points.length - 1].x).toBeCloseTo(b.x, 0);
  });

  test('groups wrap their nodes and keep their labels', async () => {
    const layout = await layoutChart(GROUPED);
    expect(layout.groups.map((g) => [g.id, g.label])).toEqual([
      ['g1', 'Milestone one'],
      ['g2', 'Milestone two'],
    ]);
    const groupOf = new Map(layout.groups.map((g) => [g.id, g]));
    for (const spec of GROUPED.nodes) {
      const box = boxOf(layout, spec.id);
      for (const group of layout.groups) {
        expect(contains(group, box)).toBe(spec.group === group.id);
      }
      const own = spec.group == null ? undefined : groupOf.get(spec.group);
      if (own !== undefined) {
        // The label band: a member never rides up into the group's top padding.
        expect(box.y - own.y).toBeGreaterThanOrEqual(40 - 0.5);
      }
    }
  });

  test('a node naming an unknown group sits at the root and empty groups are skipped', async () => {
    const layout = await layoutChart({
      nodes: [node('a', 'g1'), node('b', 'nope'), node('c', null)],
      edges: [edge('a', 'b'), edge('b', 'c')],
      groups: [
        { id: 'g1', label: 'One' },
        { id: 'empty', label: 'Nobody here' },
      ],
    });
    expect(layout.groups.map((g) => g.id)).toEqual(['g1']);
    const [g1] = layout.groups;
    expect(contains(g1, boxOf(layout, 'a'))).toBe(true);
    expect(contains(g1, boxOf(layout, 'b'))).toBe(false);
    expect(contains(g1, boxOf(layout, 'c'))).toBe(false);
  });

  test('drops dangling edges, self-loops and repeated pairs', async () => {
    const layout = await layoutChart({
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        edge('a', 'b', 'first'),
        edge('a', 'missing'),
        edge('ghost', 'c'),
        edge('b', 'b'),
        edge('a', 'b', 'second'),
        edge('b', 'c'),
      ],
    });
    expect(layout.edges.map((e) => e.id)).toEqual(['first', 'b>c']);
    expect(layout.nodes.size).toBe(3);
  });

  test('a cycle still lays out', async () => {
    const layout = await layoutChart({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    });
    expect(layout.nodes.size).toBe(3);
    expect(layout.edges.map((e) => e.id)).toEqual(['a>b', 'b>c', 'c>a']);
    expectSoundRoutes(layout);
  });

  test('a cycle across groups still lays out', async () => {
    const layout = await layoutChart({
      nodes: [node('a', 'g1'), node('b', 'g2'), node('c', 'g3')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
      groups: THREE_GROUPS,
    });
    expect(layout.edges.map((e) => e.id)).toEqual(['a>b', 'b>c', 'c>a']);
    expectSoundRoutes(layout);
  });

  test('a chain inside a group reads left to right too', async () => {
    const ids = ['a', 'b', 'c'];
    const layout = await layoutChart({
      nodes: ids.map((id) => node(id, 'g1')),
      edges: [edge('a', 'b'), edge('b', 'c')],
      groups: [{ id: 'g1', label: 'One' }],
    });
    expectLeftToRight(layout, ids);
  });

  test('free choices follow model order', async () => {
    const loose = ['c', 'a', 'b'];
    const flat = await layoutChart({
      nodes: loose.map((id) => node(id)),
      edges: [],
    });
    const ys = loose.map((id) => boxOf(flat, id).y);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
    // A group sits where its first node does; the output keeps the groups spec's order.
    const grouped = await layoutChart({
      nodes: [node('p', 'g2'), node('q', 'g1'), node('s', 'g3')],
      edges: [],
      groups: THREE_GROUPS,
    });
    expect(grouped.groups.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
    const [g1, g2, g3] = grouped.groups;
    expect(g2.y).toBeLessThan(g1.y);
    expect(g1.y).toBeLessThan(g3.y);
  });

  test('random grouped graphs with cycles keep routes square and members in their groups', async () => {
    const random = seeded(42);
    const pick = (n: number) => Math.floor(random() * n);
    for (let run = 0; run < 40; run++) {
      const groupCount = pick(4);
      const groups = Array.from({ length: groupCount }, (_, i) => ({
        id: `r${run}g${i}`,
        label: `Group ${i}`,
      }));
      const count = 2 + pick(14);
      const nodes = Array.from({ length: count }, (_, i) => ({
        id: `r${run}n${i}`,
        width: 100 + pick(120),
        height: 40 + pick(30),
        group:
          groupCount > 0 && random() < 0.8 ? groups[pick(groupCount)].id : null,
      }));
      const edges = Array.from({ length: pick(count * 2) }, (_, i) =>
        edge(nodes[pick(count)].id, nodes[pick(count)].id, `r${run}e${i}`)
      );
      const kept = new Set(
        edges.filter((e) => e.from !== e.to).map((e) => `${e.from}>${e.to}`)
      );

      const layout = await layoutChart({ nodes, edges, groups });
      expect({ run, routed: layout.edges.length }).toEqual({
        run,
        routed: kept.size,
      });
      expectSoundRoutes(layout);
      for (const spec of nodes) {
        const box = boxOf(layout, spec.id);
        for (const group of layout.groups) {
          expect({
            run,
            node: spec.id,
            group: group.id,
            inside: contains(group, box),
          }).toEqual({
            run,
            node: spec.id,
            group: group.id,
            inside: spec.group === group.id,
          });
        }
      }
    }
  });

  test('an identical spec is served from the cache', async () => {
    const spec = (): ChartSpec => ({
      nodes: [node('cache-a'), node('cache-b')],
      edges: [edge('cache-a', 'cache-b')],
    });
    const first = await layoutChart(spec());
    expect(await layoutChart(spec())).toBe(first);
    const resized = await layoutChart({
      nodes: [{ ...node('cache-a'), width: 200 }, node('cache-b')],
      edges: [edge('cache-a', 'cache-b')],
    });
    expect(resized).not.toBe(first);
    expect(boxOf(resized, 'cache-a').width).toBe(200);
  });

  test('identical specs requested together share one run', async () => {
    const spec = (): ChartSpec => ({
      nodes: [node('pair-a'), node('pair-b')],
      edges: [edge('pair-a', 'pair-b')],
    });
    const pending = layoutChart(spec());
    expect(layoutChart(spec())).toBe(pending);
    const [first, second] = await Promise.all([pending, layoutChart(spec())]);
    expect(second).toBe(first);
  });

  test('a renamed group lays out exactly as before, so views never jitter', async () => {
    const before = await layoutChart(GROUPED);
    const after = await layoutChart({
      ...GROUPED,
      groups: [
        { id: 'g1', label: 'Renamed' },
        { id: 'g2', label: 'Milestone two' },
      ],
    });
    expect(after).not.toBe(before);
    expect(after.groups.map((g) => g.label)).toEqual([
      'Renamed',
      'Milestone two',
    ]);
    const boxes = (layout: ChartLayout) =>
      layout.groups.map((g) => [g.id, g.x, g.y, g.width, g.height]);
    expect(boxes(after)).toEqual(boxes(before));
    expect([...after.nodes.values()]).toEqual([...before.nodes.values()]);
    expect(after.edges).toEqual(before.edges);
  });

  test('the cache keys on the cleaned spec, so dropped input does not miss it', async () => {
    const nodes = [node('clean-a'), node('clean-b')];
    const first = await layoutChart({
      nodes,
      edges: [edge('clean-a', 'clean-b')],
    });
    const noisy = await layoutChart({
      nodes: [...nodes, node('clean-a')],
      edges: [
        edge('clean-a', 'clean-b'),
        edge('clean-a', 'clean-a'),
        edge('clean-a', 'nowhere'),
        edge('clean-a', 'clean-b', 'repeat'),
      ],
      groups: [{ id: 'unused', label: 'Nobody here' }],
    });
    expect(noisy).toBe(first);
  });

  test('the cache keeps the twelve most recently used layouts', async () => {
    const spec = (n: number): ChartSpec => ({
      nodes: [node(`lru-${n}`)],
      edges: [],
    });
    const kept = await layoutChart(spec(0));
    for (let n = 1; n <= 11; n++) await layoutChart(spec(n));
    // Touching it makes it the freshest, so the next newcomer evicts lru-1 instead.
    expect(await layoutChart(spec(0))).toBe(kept);
    await layoutChart(spec(12));
    expect(await layoutChart(spec(0))).toBe(kept);
    for (let n = 13; n <= 24; n++) await layoutChart(spec(n));
    expect(await layoutChart(spec(0))).not.toBe(kept);
  });
});

describe('roundedPath', () => {
  test('rounds an L-shaped corner', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 30 },
      ])
    ).toBe('M0 0L14 0Q20 0 20 6L20 30');
  });

  test('caps the radius at half the shorter neighboring segment', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 30 },
      ])
    ).toBe('M0 0L2 0Q4 0 4 2L4 30');
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 40 },
        ],
        10
      )
    ).toBe('M0 0L30 0Q40 0 40 10L40 40');
  });

  test('a zero radius leaves corners sharp', () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 30 },
        ],
        0
      )
    ).toBe('M0 0L20 0L20 30');
  });

  test('one or two points draw a straight line', () => {
    expect(
      roundedPath([
        { x: 1.234, y: 5 },
        { x: 10, y: 5 },
      ])
    ).toBe('M1.23 5L10 5');
    expect(roundedPath([{ x: 3, y: 4 }])).toBe('M3 4L3 4');
    expect(roundedPath([])).toBe('');
  });
});
