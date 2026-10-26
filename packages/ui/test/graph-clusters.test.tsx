import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { GraphLegend } from '../src/graph/graph-legend';
import { CLUSTER_METRICS, layoutGraph, measureNode } from '../src/graph/layout';
import {
  gridColumns,
  packGrid,
  packShelves,
  shelfWidth,
} from '../src/graph/pack';
import { pathContext, pathNameCounts } from '../src/graph/paths';
import type {
  GraphClusterData,
  GraphEdgeData,
  GraphLayout,
  GraphNodeData,
  GraphNodeReadiness,
  LaidOutGroup,
  LaidOutNode,
} from '../src/graph/types';

// Every item, framed by parent (owner decision 2026-10-23, "the graph shows
// every issue, not only blocking ones"; architecture §8.4 Graph): given
// `clusters`, the graph lays its boxes out in labelled, nested frames, the
// boxes on an arrow flowing by blocking and the rest packed into a grid, and
// names each box by the frames it sits in. A box on no relation at all says
// "No dependencies" in its name and readout, never as a chip.

afterEach(cleanup);

type Box = { x: number; y: number; width: number; height: number };

function inside(inner: Box, outer: Box, pad = { x: 0, top: 0, bottom: 0 }) {
  return (
    inner.x >= outer.x + pad.x &&
    inner.y >= outer.y + pad.top &&
    inner.x + inner.width <= outer.x + outer.width - pad.x &&
    inner.y + inner.height <= outer.y + outer.height - pad.bottom
  );
}

/**
 * Points every ~2px along an edge path of M, L and C commands (what
 * basisPath writes), to test where the drawn curve actually runs.
 */
function curvePoints(d: string): { x: number; y: number }[] {
  const tokens = d.match(/[MLC]|-?\d*\.?\d+/g) ?? [];
  const out: { x: number; y: number }[] = [];
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
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(to.x - at.x, to.y - at.y) / 2)
      );
      for (let k = 1; k <= steps; k += 1) {
        out.push({
          x: at.x + ((to.x - at.x) * k) / steps,
          y: at.y + ((to.y - at.y) * k) / steps,
        });
      }
      at = to;
    } else {
      const [c1, c2, to] = [next(), next(), next()];
      const steps = 64;
      for (let k = 1; k <= steps; k += 1) {
        const t = k / steps;
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

/** `p` lies on `box`'s border (within half a pixel). */
function onBorder(p: { x: number; y: number }, box: Box): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  const within =
    p.x >= box.x - 0.5 &&
    p.x <= box.x + box.width + 0.5 &&
    p.y >= box.y - 0.5 &&
    p.y <= box.y + box.height + 0.5;
  return (
    within &&
    (near(p.x, box.x) ||
      near(p.x, box.x + box.width) ||
      near(p.y, box.y) ||
      near(p.y, box.y + box.height))
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

const READY: GraphNodeReadiness = {
  state: 'ready',
  label: 'Ready',
  tone: 'success',
  blockedBy: 0,
  unblocks: 1,
};
const BLOCKED: GraphNodeReadiness = {
  state: 'blocked',
  label: 'Blocked by 1',
  tone: 'warning',
  blockedBy: 1,
  unblocks: 0,
};
const FREE: GraphNodeReadiness = {
  state: 'independent',
  label: 'No dependencies',
  tone: 'default',
  blockedBy: 0,
  unblocks: 0,
};
const DONE: GraphNodeReadiness = {
  state: 'done',
  label: '',
  tone: 'muted',
  blockedBy: 0,
  unblocks: 0,
};

const CLUSTERS: GraphClusterData[] = [
  { id: 'p1', label: 'Orion' },
  { id: 'm1', label: 'Beta', parent: 'p1' },
  { id: 'm2', label: 'GA', parent: 'p1' },
  { id: 'p2', label: 'Halo', muted: true },
  { id: 'm3', label: 'Docs', parent: 'p2', muted: true },
  { id: 'empty', label: 'Nothing in it' },
  { id: 'px', label: 'Outside', external: true },
  { id: 'mx', label: 'Theirs', parent: 'px', external: true },
];

function issue(
  id: string,
  cluster: string | undefined,
  readiness: GraphNodeReadiness = FREE
): GraphNodeData {
  return {
    id,
    key: id.toUpperCase(),
    label: `Issue ${id}`,
    sublabel: `${id.toUpperCase()} · Ana`,
    tone: readiness.state === 'done' ? 'muted' : 'default',
    status: readiness.state === 'done' ? 'done' : 'open',
    cluster,
    readiness,
  };
}

// Beta holds a1 → a2 and twelve loose issues, two of them done (listed
// first, so the grid must move them last); GA's b1 waits on a2 (across
// milestones) and on c1 (across projects); x1, an external, blocks a1;
// t1 has no cluster and t2 an unknown one.
const LOOSE = Array.from({ length: 12 }, (_, i) =>
  issue(`l${i + 1}`, 'm1', i < 2 ? DONE : FREE)
);
const NODES: GraphNodeData[] = [
  issue('a1', 'm1', BLOCKED),
  issue('a2', 'm1', { ...BLOCKED, unblocks: 1 }),
  ...LOOSE,
  issue('b1', 'm2', { ...BLOCKED, blockedBy: 2, label: 'Blocked by 2' }),
  issue('b2', 'm2'),
  issue('c1', 'm3', READY),
  issue('c2', 'm3'),
  { ...issue('x1', 'mx', READY), external: true },
  issue('t1', undefined),
  issue('t2', 'nope'),
];
const EDGES: GraphEdgeData[] = [
  { from: 'a1', to: 'a2', kind: 'default' },
  { from: 'a2', to: 'b1', kind: 'default' },
  { from: 'c1', to: 'b1', kind: 'cross', cross: true },
  { from: 'x1', to: 'a1', kind: 'cross', cross: true },
];

function laid(): GraphLayout {
  return layoutGraph(NODES, EDGES, { clusters: CLUSTERS });
}

function nodeOf(layout: GraphLayout, id: string): LaidOutNode {
  const found = layout.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

function frameOf(layout: GraphLayout, id: string): LaidOutGroup {
  const found = layout.groups.find((g) => g.id === id);
  if (found === undefined) throw new Error(`no frame ${id}`);
  return found;
}

const CONTENT = {
  x: CLUSTER_METRICS.padX,
  top: CLUSTER_METRICS.padTop,
  bottom: CLUSTER_METRICS.padBottom,
};

describe('packing helpers', () => {
  test('gridColumns aims at a wide grid and fills the room above it', () => {
    const cell = { width: 200, height: 60 };
    expect(gridColumns(0, cell, 16, 3)).toBe(0);
    expect(gridColumns(1, cell, 16, 3)).toBe(1);
    // Two or three wide boxes never stack in one column under a narrow
    // flow (the demo's Compass and Ember, 170 × 54; ENG-11 and ENG-13,
    // 204 × 76): rounding the aspect rule alone gave them one.
    expect(gridColumns(2, { width: 170, height: 54 }, 16, 3, 168)).toBe(2);
    expect(gridColumns(2, { width: 204, height: 76 }, 16, 3)).toBe(2);
    expect(gridColumns(3, { width: 204, height: 76 }, 16, 3)).toBe(2);
    expect(gridColumns(12, cell, 16, 3)).toBe(3);
    expect(gridColumns(40, cell, 16, 3)).toBe(6);
    // Never more columns than cells, however much room.
    expect(gridColumns(3, cell, 16, 3, 10_000)).toBe(3);
    // Widened while one more column still fits in 1000px.
    expect(gridColumns(12, cell, 16, 3, 1000)).toBe(4);
  });

  test('packGrid: a table, each cell centred in its column, top of its row', () => {
    const packed = packGrid(
      [
        { width: 100, height: 40 },
        { width: 60, height: 50 },
        { width: 80, height: 30 },
      ],
      2,
      10,
      5
    );
    expect(packed).toEqual({
      positions: [
        { x: 0, y: 0 },
        { x: 110, y: 0 },
        { x: 10, y: 55 },
      ],
      width: 170,
      height: 85,
    });
    expect(packGrid([], 3, 10, 5)).toEqual({
      positions: [],
      width: 0,
      height: 0,
    });
  });

  test('packShelves: next fit, a too-wide block alone on its row', () => {
    const packed = packShelves(
      [
        { width: 100, height: 40 },
        { width: 100, height: 60 },
        { width: 300, height: 10 },
        { width: 50, height: 20 },
      ],
      220,
      20,
      10
    );
    expect(packed).toEqual({
      positions: [
        { x: 0, y: 0 },
        { x: 120, y: 0 },
        { x: 0, y: 70 },
        { x: 0, y: 90 },
      ],
      width: 300,
      height: 110,
    });
  });

  test('shelfWidth: the widest block, the room above, or the area', () => {
    const sizes = [
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    ];
    expect(shelfWidth(sizes, 2)).toBe(200);
    expect(shelfWidth(sizes, 2, 500)).toBe(500);
    expect(shelfWidth([{ width: 900, height: 10 }], 1)).toBe(900);
  });
});

describe('the clustered layout', () => {
  test('frames nest, and every box sits inside its own frame', () => {
    const layout = laid();
    expect(layout.clustered).toBe(true);
    for (const node of NODES) {
      if (node.cluster === undefined || node.cluster === 'nope') continue;
      expect([
        node.id,
        inside(nodeOf(layout, node.id), frameOf(layout, node.cluster), CONTENT),
      ]).toEqual([node.id, true]);
    }
    for (const cluster of CLUSTERS) {
      if (cluster.parent === undefined || cluster.id === 'empty') continue;
      expect([
        cluster.id,
        inside(
          frameOf(layout, cluster.id),
          frameOf(layout, cluster.parent),
          CONTENT
        ),
      ]).toEqual([cluster.id, true]);
    }
  });

  test('no two boxes overlap, and no two sibling frames do', () => {
    const layout = laid();
    const hits: string[] = [];
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        if (overlaps(layout.nodes[i], layout.nodes[j])) {
          hits.push(`${layout.nodes[i].id} × ${layout.nodes[j].id}`);
        }
      }
    }
    const siblings = (parent: string | undefined) =>
      CLUSTERS.filter((c) => c.parent === parent && c.id !== 'empty').map((c) =>
        frameOf(layout, c.id)
      );
    for (const parent of [undefined, 'p1', 'p2', 'px']) {
      const frames = siblings(parent);
      for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
          if (overlaps(frames[i], frames[j])) {
            hits.push(`${frames[i].id} × ${frames[j].id}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test('frames come parents first, with their depth and look; an empty cluster has none', () => {
    const layout = laid();
    expect(
      layout.groups.map((g) => [
        g.id,
        g.label,
        g.kind,
        g.depth,
        g.muted,
        g.external,
      ])
    ).toEqual([
      ['p1', 'Orion', 'cluster', 0, false, false],
      ['m1', 'Beta', 'cluster', 1, false, false],
      ['m2', 'GA', 'cluster', 1, false, false],
      ['p2', 'Halo', 'cluster', 0, true, false],
      ['m3', 'Docs', 'cluster', 1, true, false],
      ['px', 'Outside', 'cluster', 0, false, true],
      ['mx', 'Theirs', 'cluster', 1, false, true],
    ]);
  });

  test('boxes on no arrow pack into a grid under the flow, done ones last', () => {
    const layout = laid();
    const grid = LOOSE.map((n) => nodeOf(layout, n.id));
    expect(new Set(grid.map((n) => n.x + n.width / 2)).size).toBeGreaterThan(2);
    expect(new Set(grid.map((n) => n.y)).size).toBeGreaterThan(1);
    // Far shorter than the column the unclustered layout stacks them in.
    const column = layoutGraph(
      LOOSE.map((n) => ({ ...n, cluster: undefined })),
      []
    );
    const gridHeight =
      Math.max(...grid.map((n) => n.y + n.height)) -
      Math.min(...grid.map((n) => n.y));
    expect(gridHeight * 2).toBeLessThan(column.height);
    // Under the flow (a1, a2).
    const flowBottom = Math.max(
      ...['a1', 'a2'].map((id) => nodeOf(layout, id)).map((n) => n.y + n.height)
    );
    expect(Math.min(...grid.map((n) => n.y))).toBeGreaterThan(flowBottom);
    // l1 and l2 are done: the last two cells of Beta's reading order.
    const beta = layout.nodes
      .map((n) => n.id)
      .filter((id) => NODES.find((n) => n.id === id)?.cluster === 'm1');
    expect(beta.slice(-2)).toEqual(['l1', 'l2']);
  });

  test('linked boxes flow along the direction, LR and TB', () => {
    const lr = laid();
    expect(nodeOf(lr, 'a1').x + nodeOf(lr, 'a1').width).toBeLessThan(
      nodeOf(lr, 'a2').x
    );
    const tb = layoutGraph(NODES, EDGES, {
      clusters: CLUSTERS,
      direction: 'TB',
    });
    expect(nodeOf(tb, 'a1').y + nodeOf(tb, 'a1').height).toBeLessThan(
      nodeOf(tb, 'a2').y
    );
    for (const node of NODES) {
      if (node.cluster === undefined || node.cluster === 'nope') continue;
      expect(
        inside(nodeOf(tb, node.id), frameOf(tb, node.cluster), CONTENT)
      ).toBe(true);
    }
  });

  test('an arrow between frames leaves the far side and enters the near side', () => {
    const layout = laid();
    const a2 = nodeOf(layout, 'a2');
    const b1 = nodeOf(layout, 'b1');
    const edge = layout.edges.find((e) => e.key === 'a2->b1');
    expect(edge).toBeDefined();
    const points = edge?.points ?? [];
    expect(points[0]).toEqual({ x: a2.x + a2.width, y: a2.y + a2.height / 2 });
    expect(points.at(-1)).toEqual({ x: b1.x, y: b1.y + b1.height / 2 });
    // It leaves and enters straight, CLUSTER_METRICS.lead out.
    expect(points[1]).toEqual({
      x: a2.x + a2.width + CLUSTER_METRICS.lead,
      y: a2.y + a2.height / 2,
    });
    expect(edge?.arrow.startsWith(`M${b1.x},${b1.y + b1.height / 2}`)).toBe(
      true
    );
    // Every kept edge is drawn, the external's and the cross-project one.
    expect(layout.edges.map((e) => e.key).sort()).toEqual(
      ['a1->a2', 'a2->b1', 'c1->b1', 'x1->a1'].sort()
    );
  });

  test('a backward arrow between frames leaves the near side and enters the far side', () => {
    // f0 ⇄ f1 through different boxes: one of the two arrows runs back.
    const nodes = [
      issue('u1', 'f0', READY),
      issue('u2', 'f0', BLOCKED),
      issue('v1', 'f1', BLOCKED),
      issue('v2', 'f1', READY),
    ];
    const layout = layoutGraph(
      nodes,
      [
        { from: 'u1', to: 'v1', kind: 'default' },
        { from: 'v2', to: 'u2', kind: 'default' },
      ],
      {
        clusters: [
          { id: 'f0', label: 'F0' },
          { id: 'f1', label: 'F1' },
        ],
      }
    );
    const centre = (n: LaidOutNode) => n.x + n.width / 2;
    for (const edge of layout.edges) {
      const from = nodeOf(layout, edge.from);
      const to = nodeOf(layout, edge.to);
      const backward = centre(to) < centre(from);
      expect(edge.points[0].x).toBe(backward ? from.x : from.x + from.width);
      expect(edge.points.at(-1)?.x).toBe(backward ? to.x + to.width : to.x);
    }
    expect(
      layout.edges.some(
        (e) => centre(nodeOf(layout, e.to)) < centre(nodeOf(layout, e.from))
      )
    ).toBe(true);
  });

  test('an arrow between frames runs round the other boxes it passes, never behind them', () => {
    // The demo's milestone level: Dual-write (w1) holds up Read path switch
    // (w2) in its own frame and Search v2 beta (s1) in the next one, which
    // holds up Tokens and type (t1). Straight from w1 to the frames' route,
    // w1 → s1 ran behind w2 and read as w1 → w2 → s1. Left to right only,
    // the direction every host lays frames out in: top to bottom, a frame's
    // grid sits under its flow, in the way out (README, "clusters").
    const box = (
      id: string,
      cluster: string,
      readiness: GraphNodeReadiness
    ) => ({
      ...issue(id, cluster, readiness),
      label: `Milestone ${id} with a longer name`,
      sublabel: 'Atlas billing migration · Oct 20',
    });
    const nodes = [
      box('w1', 'fa', READY),
      box('w2', 'fa', BLOCKED),
      box('w3', 'fa', DONE),
      box('s1', 'fb', BLOCKED),
      box('s2', 'fb', FREE),
      box('t1', 'fc', BLOCKED),
      box('t2', 'fc', FREE),
    ];
    const edges: GraphEdgeData[] = [
      { from: 'w1', to: 'w2', kind: 'default' },
      { from: 'w1', to: 's1', kind: 'cross', cross: true },
      { from: 's1', to: 't1', kind: 'cross', cross: true },
    ];
    const clusters = [
      { id: 'fa', label: 'Atlas' },
      { id: 'fb', label: 'Beacon' },
      { id: 'fc', label: 'Juniper' },
    ];
    for (const direction of ['LR'] as const) {
      const layout = layoutGraph(nodes, edges, { clusters, direction });
      expect(layout.edges).toHaveLength(3);
      for (const edge of layout.edges) {
        for (const other of layout.nodes) {
          if (other.id === edge.from || other.id === edge.to) continue;
          // 2px in from each side: grazing a border is not behind it.
          const behind = curvePoints(edge.path).filter(
            (p) =>
              p.x > other.x + 2 &&
              p.x < other.x + other.width - 2 &&
              p.y > other.y + 2 &&
              p.y < other.y + other.height - 2
          );
          expect(`${edge.key} behind ${other.id}: ${behind.length}`).toBe(
            `${edge.key} behind ${other.id}: 0`
          );
        }
      }
      // Still leaves the far side straight and enters the near side.
      const w1 = nodeOf(layout, 'w1');
      const s1 = nodeOf(layout, 's1');
      const cross = layout.edges.find((e) => e.key === 'w1->s1');
      expect(cross?.points[0]).toEqual({
        x: w1.x + w1.width,
        y: w1.y + w1.height / 2,
      });
      expect(cross?.points.at(-1)).toEqual({
        x: s1.x,
        y: s1.y + s1.height / 2,
      });
      // And never turns back along the direction on the way.
      const along = (cross?.points ?? []).map((p) => p.x);
      expect(along).toEqual([...along].sort((a, b) => a - b));
    }
  });

  test('a frame starts at its top corner, not under an empty band', () => {
    // s → h → five waiting boxes: dagre centres s and h on the tall last
    // rank, which would leave a band above them where reading starts.
    const fan = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const nodes = ['s', 'h', ...fan].map((id) => issue(id, 'p'));
    const edges: GraphEdgeData[] = [
      { from: 's', to: 'h', kind: 'default' },
      ...fan.map(
        (id): GraphEdgeData => ({
          from: 'h',
          to: id,
          kind: 'default',
        })
      ),
    ];
    for (const direction of ['LR', 'TB'] as const) {
      const layout = layoutGraph(nodes, edges, {
        direction,
        clusters: [{ id: 'p', label: 'Pulse' }],
      });
      const frame = frameOf(layout, 'p');
      const s = nodeOf(layout, 's');
      const h = nodeOf(layout, 'h');
      if (direction === 'LR') {
        expect(s.y).toBe(frame.y + CLUSTER_METRICS.padTop);
        // The two first ranks rise together: s → h stays straight.
        expect(h.y + h.height / 2).toBeCloseTo(s.y + s.height / 2, 0);
      } else {
        expect(s.x).toBe(frame.x + CLUSTER_METRICS.padX);
        expect(h.x + h.width / 2).toBeCloseTo(s.x + s.width / 2, 0);
      }
      // Every arrow still starts on its blocker's border and ends on the
      // border of what waits, facing the curve (dagre's rule for ends).
      for (const edge of layout.edges) {
        const first = edge.points[0];
        const last = edge.points.at(-1) ?? first;
        expect(onBorder(first, nodeOf(layout, edge.from))).toBe(true);
        expect(onBorder(last, nodeOf(layout, edge.to))).toBe(true);
      }
      const straight = layout.edges.find((e) => e.key === 's->h');
      expect(
        new Set(straight?.points.map((p) => (direction === 'LR' ? p.y : p.x)))
          .size
      ).toBe(1);
      for (const a of layout.nodes) {
        expect(inside(a, frame, CONTENT)).toBe(true);
        for (const b of layout.nodes) {
          if (a !== b) expect(overlaps(a, b)).toBe(false);
        }
      }
    }
  });

  test('a band thinner than a box is left as dagre drew it', () => {
    // s → h → two waiting boxes: s and h sit half a box down, less than
    // CLUSTER_METRICS.liftMin, so the ranks stay where dagre put them.
    const nodes = ['s', 'h', 'w1', 'w2'].map((id) => issue(id, 'p'));
    const edges: GraphEdgeData[] = [
      { from: 's', to: 'h', kind: 'default' },
      { from: 'h', to: 'w1', kind: 'default' },
      { from: 'h', to: 'w2', kind: 'default' },
    ];
    const layout = layoutGraph(nodes, edges, {
      clusters: [{ id: 'p', label: 'Pulse' }],
    });
    const top = frameOf(layout, 'p').y + CLUSTER_METRICS.padTop;
    const band = nodeOf(layout, 's').y - top;
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(CLUSTER_METRICS.liftMin);
    expect(Math.min(nodeOf(layout, 'w1').y, nodeOf(layout, 'w2').y)).toBe(top);
  });

  test('an arrow leaving a frame runs out level to its side first', () => {
    // The demo's Dual-write: a1 holds up b1 in the next frame, and two
    // loose boxes with long names make a grid under a1 wider than its
    // flow. Straight from a1's port to the frames' route the arrow cut
    // across that grid; it now runs out to the frame's far side (2px in)
    // first, level with a1.
    const long = (id: string, cluster: string) => ({
      ...issue(id, cluster),
      label: `Issue ${id} with a much longer name than the others`,
    });
    const nodes = [
      issue('a1', 'fa', READY),
      long('l1', 'fa'),
      long('l2', 'fa'),
      issue('b1', 'fb', BLOCKED),
      issue('b2', 'fb'),
    ];
    const edges: GraphEdgeData[] = [
      { from: 'a1', to: 'b1', kind: 'cross', cross: true },
    ];
    const layout = layoutGraph(nodes, edges, {
      clusters: [
        { id: 'fa', label: 'Atlas' },
        { id: 'fb', label: 'Beacon' },
      ],
    });
    const fa = frameOf(layout, 'fa');
    const a1 = nodeOf(layout, 'a1');
    const arrow = layout.edges.find((e) => e.key === 'a1->b1');
    const points = arrow?.points ?? [];
    expect(fa.x + fa.width).toBeGreaterThan(a1.x + a1.width + 60);
    const out = points.find((p) => p.x === fa.x + fa.width - 2);
    expect(out).toBeDefined();
    expect(out?.y).toBeGreaterThanOrEqual(a1.y);
    expect(out?.y).toBeLessThanOrEqual(a1.y + a1.height);
    for (const other of layout.nodes) {
      if (other.id === 'a1' || other.id === 'b1') continue;
      const behind = curvePoints(arrow?.path ?? '').filter(
        (p) =>
          p.x > other.x + 2 &&
          p.x < other.x + other.width - 2 &&
          p.y > other.y + 2 &&
          p.y < other.y + other.height - 2
      );
      expect(`behind ${other.id}: ${behind.length}`).toBe(
        `behind ${other.id}: 0`
      );
    }
  });

  test('an edge inside one frame keeps its dagre route', () => {
    const layout = laid();
    const a1 = nodeOf(layout, 'a1');
    const a2 = nodeOf(layout, 'a2');
    const points = layout.edges.find((e) => e.key === 'a1->a2')?.points ?? [];
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0].x).toBeGreaterThanOrEqual(a1.x + a1.width - 1);
    expect(points.at(-1)?.x).toBeLessThanOrEqual(a2.x + 1);
  });

  test('reading order goes frame by frame; unknown clusters sit at the top', () => {
    const layout = laid();
    const order = layout.nodes.map((n) => n.id);
    const runOf = (cluster: string) =>
      order
        .map((id, i) => [id, i] as const)
        .filter(([id]) => NODES.find((n) => n.id === id)?.cluster === cluster)
        .map(([, i]) => i);
    for (const cluster of ['m1', 'm2', 'm3', 'mx']) {
      const run = runOf(cluster);
      expect(run.at(-1)! - run[0] + 1).toBe(run.length);
    }
    // t1 (no cluster) and t2 (an unknown one) are top-level boxes: in no
    // frame, so outside every frame.
    for (const id of ['t1', 't2']) {
      const box = nodeOf(layout, id);
      expect(layout.groups.some((g) => inside(box, g))).toBe(false);
    }
  });

  test('is deterministic, from fresh copies too', () => {
    const a = laid();
    expect(laid()).toEqual(a);
    expect(
      layoutGraph(structuredClone(NODES), structuredClone(EDGES), {
        clusters: structuredClone(CLUSTERS),
      })
    ).toEqual(a);
  });

  test('a parent loop or a missing parent ends at the top level', () => {
    const layout = layoutGraph(
      [issue('q1', 'loopA'), issue('q2', 'loopB'), issue('q3', 'orphan')],
      [{ from: 'q1', to: 'q2', kind: 'default' }],
      {
        clusters: [
          { id: 'loopA', label: 'A', parent: 'loopB' },
          { id: 'loopB', label: 'B', parent: 'loopA' },
          { id: 'orphan', label: 'O', parent: 'gone' },
        ],
      }
    );
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(layout.groups.map((g) => g.id).sort()).toEqual([
      'loopA',
      'loopB',
      'orphan',
    ]);
    expect(layout.edges).toHaveLength(1);
  });

  test('a long chain of linked frames goes onto shelves, its arrows kept', () => {
    const count = 14;
    const nodes = Array.from({ length: count }, (_, i) =>
      issue(`k${i}`, `f${i}`, READY)
    );
    const clusters = nodes.map((_, i) => ({ id: `f${i}`, label: `F${i}` }));
    const edges: GraphEdgeData[] = nodes.slice(1).map((n, i) => ({
      from: `k${i}`,
      to: n.id,
      kind: 'default',
    }));
    const layout = layoutGraph(nodes, edges, { clusters });
    // As one dagre row it would run about 14 × 280px; on shelves it stays
    // inside the cap (plus the margins).
    expect(layout.width).toBeLessThanOrEqual(CLUSTER_METRICS.flowMax + 2 * 24);
    expect(layout.groups).toHaveLength(count);
    expect(layout.edges).toHaveLength(count - 1);
    // Shelved in flow order: each frame's predecessor reads before it.
    const order = layout.nodes.map((n) => n.id);
    expect(order).toEqual(nodes.map((n) => n.id));
  });

  test('an empty clusters list still packs the loose top-level boxes', () => {
    const loose = Array.from({ length: 20 }, (_, i) =>
      issue(`z${i}`, undefined)
    );
    const packed = layoutGraph(loose, [], { clusters: [] });
    const flat = layoutGraph(loose, []);
    expect(packed.groups).toEqual([]);
    expect(new Set(packed.nodes.map((n) => n.x)).size).toBeGreaterThan(2);
    expect(new Set(flat.nodes.map((n) => n.x)).size).toBe(1);
    expect(packed.height).toBeLessThan(flat.height / 2);
  });

  test('a big, dense frame lays out without overlaps', () => {
    const count = 130;
    const nodes = Array.from({ length: count }, (_, i) =>
      issue(`d${i}`, 'big', READY)
    );
    const edges: GraphEdgeData[] = [];
    for (let i = 0; i < count; i += 1) {
      for (const step of [1, 7]) {
        if (i + step < count) {
          edges.push({ from: `d${i}`, to: `d${i + step}`, kind: 'default' });
        }
      }
    }
    expect(edges.length).toBeGreaterThan(CLUSTER_METRICS.simplexLinks);
    const layout = layoutGraph(nodes, edges, {
      clusters: [{ id: 'big', label: 'Big' }],
    });
    const hits: string[] = [];
    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        if (overlaps(layout.nodes[i], layout.nodes[j])) hits.push('x');
      }
    }
    expect(hits).toEqual([]);
    expect(layout.edges).toHaveLength(edges.length);
  });

  test('a box with no dependencies measures with no chip row', () => {
    const plain = measureNode({
      ...issue('p', undefined),
      readiness: undefined,
    });
    expect(measureNode(issue('p', undefined, FREE))).toEqual(plain);
    expect(measureNode(issue('p', undefined, READY)).height).toBeGreaterThan(
      plain.height
    );
  });
});

describe('DependencyGraph with clusters', () => {
  function renderGraph() {
    return render(
      <DependencyGraph
        nodes={NODES}
        edges={EDGES}
        clusters={CLUSTERS}
        ariaSummary="Every issue."
        emptyMessage="Nothing."
        highlight="status"
        onSelect={() => undefined}
      />
    );
  }

  test('draws each frame, decorative, with its title above the arrows', () => {
    const { container } = renderGraph();
    const frames = [...container.querySelectorAll('[data-graph-cluster]')];
    expect(frames.map((f) => f.getAttribute('data-graph-cluster'))).toEqual([
      'p1',
      'm1',
      'm2',
      'p2',
      'm3',
      'px',
      'mx',
    ]);
    expect(frames.every((f) => f.getAttribute('aria-hidden') === 'true')).toBe(
      true
    );
    const halo = container.querySelector('[data-graph-cluster="p2"]');
    expect(halo?.hasAttribute('data-muted')).toBe(true);
    expect(
      container
        .querySelector('[data-graph-cluster="px"]')
        ?.hasAttribute('data-external')
    ).toBe(true);
    const titles = [
      ...container.querySelectorAll('[data-graph-cluster-title]'),
    ];
    expect(titles.map((t) => t.textContent)).toEqual([
      'Orion',
      'Beta',
      'GA',
      'Halo',
      'Docs',
      'Outside',
      'Theirs',
    ]);
    // The titles come after the drawing of the arrows (painted above it)
    // and before the boxes.
    const svg = container.querySelector('svg[role="img"]');
    const firstBox = container.querySelector('[data-graph-node]');
    for (const title of titles) {
      expect(svg?.compareDocumentPosition(title) ?? 0).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
      expect(title.compareDocumentPosition(firstBox as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    }
  });

  test('a box is named by the frames it sits in, innermost first', () => {
    const { container } = renderGraph();
    const name = (id: string) =>
      container
        .querySelector(`[data-graph-node="${id}"]`)
        ?.getAttribute('aria-label') ?? '';
    expect(name('a1')).toContain('A1 · Ana. in Beta, Orion.');
    expect(name('c1')).toContain('in Docs, Halo.');
    expect(name('t1')).not.toContain(' in ');
    expect(name('t2')).not.toContain(' in ');
  });

  test('"No dependencies" is said, not drawn as a chip', () => {
    const { container } = renderGraph();
    const box = container.querySelector('[data-graph-node="l5"]');
    expect(box?.getAttribute('data-readiness')).toBe('independent');
    expect(box?.querySelector('[data-readiness-chip]')).toBeNull();
    expect(box?.getAttribute('aria-label')).toContain('no dependencies');
    // A ready box keeps its chip.
    expect(
      container
        .querySelector('[data-graph-node="c1"]')
        ?.querySelector('[data-readiness-chip]')?.textContent
    ).toBe('Ready');
    // The readout says the word and nothing about paths.
    fireEvent.pointerEnter(box as Element, { pointerType: 'mouse' });
    expect(container.querySelector('[data-graph-readout]')?.textContent).toBe(
      'L5 · No dependencies'
    );
  });

  test('arrow keys move to the nearest box that way', () => {
    const { container } = renderGraph();
    const layout = laid();
    const centre = (n: LaidOutNode) => ({
      x: n.x + n.width / 2,
      y: n.y + n.height / 2,
    });
    // A cell of Beta's grid with a cell to its right and one below it,
    // worked out from the layout.
    const cells = LOOSE.map((n) => nodeOf(layout, n.id));
    const rightOf = (c: LaidOutNode) =>
      cells
        .filter((n) => n.y === c.y && centre(n).x > centre(c).x)
        .sort((a, b) => a.x - b.x)[0];
    const belowOf = (c: LaidOutNode) =>
      cells
        .filter((n) => centre(n).x === centre(c).x && n.y > c.y)
        .sort((a, b) => a.y - b.y)[0];
    const cell = cells.find(
      (c) => rightOf(c) !== undefined && belowOf(c) !== undefined
    );
    expect(cell).toBeDefined();
    if (cell === undefined) return;
    const at = (id: string) =>
      container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
    at(cell.id)?.focus();
    fireEvent.keyDown(at(cell.id) as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(at(rightOf(cell).id));
    at(cell.id)?.focus();
    fireEvent.keyDown(at(cell.id) as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(at(belowOf(cell).id));
    // Nothing lies left of the leftmost box of the whole drawing.
    const leftmost = [...layout.nodes].sort((a, b) => a.x - b.x)[0];
    at(leftmost.id)?.focus();
    fireEvent.keyDown(at(leftmost.id) as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(at(leftmost.id));
  });

  test('the legend draws the frames in the Nodes row', () => {
    const { container } = render(
      <GraphLegend
        items={[
          { mark: 'cluster', label: 'Milestone', note: 'its issues' },
          { mark: 'cluster-muted', label: 'Paused', note: 'inactive work' },
          { mark: 'node', label: 'No dependencies' },
        ]}
      />
    );
    const rows = [...container.querySelectorAll('[role="group"] > div')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent?.startsWith('Nodes')).toBe(true);
    expect(
      [...container.querySelectorAll('[data-mark]')].map((m) =>
        m.getAttribute('data-mark')
      )
    ).toEqual(['cluster', 'cluster-muted', 'node']);
  });
});

describe('names stay transitive in a graph of every issue', () => {
  test('boxes on no arrow do not count against the walk budget', () => {
    const loose = Array.from({ length: 3000 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`,
    }));
    const nodes = [
      ...loose,
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    const counts = pathNameCounts(
      pathContext(nodes, [
        { from: 'a', to: 'b', kind: 'default' },
        { from: 'b', to: 'c', kind: 'default' },
      ])
    );
    expect(counts.get('a')).toEqual({
      transitive: true,
      waitsOn: 0,
      holdsUp: 2,
      unblocks: 1,
      outside: false,
      unblocksNotDrawn: 0,
    });
    expect(counts.get('n7')).toEqual({
      transitive: true,
      waitsOn: 0,
      holdsUp: 0,
      unblocks: 0,
      outside: false,
      unblocksNotDrawn: 0,
    });
  });
});

describe('cluster styles', () => {
  const css = readFileSync(
    path.join(
      import.meta.dir,
      '..',
      'src',
      'graph',
      'dependency-graph.module.css'
    ),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
  const rule = (selector: string, from = 0): string => {
    const at = css.indexOf(`${selector} {`, from);
    expect([selector, at >= 0]).toEqual([selector, true]);
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  };

  test('a soft rounded frame, a sentence-case title on a canvas patch, a dashed grey muted frame, dashes outside', () => {
    // 3:1 on the canvas: the frame is the only cue that groups.
    expect(rule('.cluster')).toContain(
      'border: 1px solid var(--control-border)'
    );
    expect(rule('.cluster')).toContain('border-radius: var(--r-lg)');
    // The title's patch is the canvas colour, so an arrow passes behind it.
    expect(rule('.clusterTitle')).toContain('background: var(--sunken)');
    expect(rule('.clusterTitle')).not.toContain('text-transform');
    expect(rule('.clusterTitle')).not.toContain('font-family');
    expect(rule('.clusterTitle')).toContain('font-weight: var(--fw-semibold)');
    expect(rule('.clusterTitle')).toContain('color: var(--text-3)');
    expect(rule('.clusterTitleTop')).toContain('color: var(--text-2)');
    expect(rule('.clusterTitleMuted')).toContain('color: var(--text-3)');
    expect(rule('.clusterMuted')).toContain('border-style: dashed');
    expect(rule('.clusterMuted')).toContain('border-color: var(--gray)');
    expect(css).not.toContain('--hatch');
    expect(rule('.clusterExternal')).toContain('border-style: dashed');
  });

  test('forced colours keep the frames and their titles', () => {
    const forced = css.indexOf('@media (forced-colors: active)');
    expect(forced).toBeGreaterThan(0);
    expect(rule('.cluster', forced)).toContain('border-color: CanvasText');
    expect(rule('.clusterMuted', forced)).toContain('border-color: GrayText');
    expect(rule('.clusterTitleMuted', forced)).toContain('color: GrayText');
  });

  test('a done box keeps its solid neutral diamond when quiet', () => {
    // The quiet box greys every hue but done's, which stays --text.
    expect(rule('.toneMuted')).not.toContain('--glyph-ink');
    expect(rule('.node')).toContain('--glyph-ink: var(--text)');
  });

  test('the title metrics match the stylesheet', () => {
    // --fs-xs is 12px (tokens.css).
    expect(rule('.clusterTitle')).toContain('font-size: var(--fs-xs)');
    expect(CLUSTER_METRICS.titleSize).toBe(12);
    expect(rule('.clusterTitle')).toContain(
      `line-height: ${CLUSTER_METRICS.titleLine}px`
    );
    // Room under the title before the content: its line and two gaps.
    const room: number =
      CLUSTER_METRICS.titleTop * 2 + CLUSTER_METRICS.titleLine;
    expect(CLUSTER_METRICS.padTop as number).toBe(room);
  });
});

// A seeded generator for small framed graphs, like a project's issue level:
// a few milestones (optionally inside a project frame), relations between
// random issues, some of them no longer blocking.
function framedGraph(seed: number): {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  clusters: GraphClusterData[];
} {
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const count = 5 + Math.floor(rand() * 16);
  const milestones = 2 + Math.floor(rand() * 2);
  const nested = rand() < 0.5;
  const clusters: GraphClusterData[] = [
    ...(nested ? [{ id: 'p', label: 'Project' }] : []),
    ...Array.from({ length: milestones }, (_, m) => ({
      id: `m${m}`,
      label: `Milestone ${m}`,
      parent: nested ? 'p' : undefined,
    })),
  ];
  const nodes = Array.from({ length: count }, (_, i) =>
    issue(`i${i}`, `m${Math.floor(rand() * milestones)}`, READY)
  );
  const edges: GraphEdgeData[] = [];
  const seen = new Set<string>();
  const wanted = Math.floor(count * (0.5 + rand()));
  for (let guard = 0; edges.length < wanted && guard < 400; guard += 1) {
    const a = Math.floor(rand() * count);
    const b = Math.floor(rand() * count);
    if (a === b || seen.has(`${a}>${b}`) || seen.has(`${b}>${a}`)) continue;
    seen.add(`${a}>${b}`);
    edges.push({
      from: `i${Math.min(a, b)}`,
      to: `i${Math.max(a, b)}`,
      kind: rand() < 0.3 ? 'resolved' : 'default',
    });
  }
  return { nodes, edges, clusters };
}

describe('the framed layout always finishes', () => {
  // dagre's network-simplex ranker pivots while a cut value is below zero;
  // with a fractional edge weight (the port edges' 0.01) a sum could stay
  // at -2e-16 and never settle, so the server's render looped forever on
  // about 1 small project in 100. The weights are whole numbers now. A
  // regression shows here as a test run that never ends.
  test('the 9-issue, 2-milestone project that looped lays out', () => {
    const min3 = {
      nodes: [
        issue('is116', 'milestone:pr64m2', READY),
        issue('is216', 'milestone:pr64m2', READY),
        issue('is243', 'milestone:pr64m1', READY),
        issue('is311', 'milestone:pr64m2', READY),
        issue('is359', 'milestone:pr64m2', READY),
        issue('is373', 'milestone:pr64m1', BLOCKED),
        issue('is548', 'milestone:pr64m2', READY),
        issue('is647', 'milestone:pr64m2', BLOCKED),
        issue('is655', 'milestone:pr64m2', BLOCKED),
      ].map((node) => ({
        ...node,
        label: `Synthetic work item ${node.id}: a realistic length title for wrapping`,
      })),
      edges: [
        ['is116', 'is373', 'default'],
        ['is216', 'is647', 'default'],
        ['is243', 'is655', 'resolved'],
        ['is311', 'is373', 'default'],
        ['is311', 'is647', 'default'],
        ['is311', 'is655', 'default'],
        ['is359', 'is548', 'resolved'],
        ['is359', 'is655', 'resolved'],
      ].map(([from, to, kind]) => ({ from, to, kind }) as GraphEdgeData),
      clusters: [
        { id: 'milestone:pr64m1', label: 'Milestone 64.1' },
        { id: 'milestone:pr64m2', label: 'Milestone 64.2' },
      ],
    };
    for (const nested of [false, true]) {
      const clusters = nested
        ? [
            { id: 'project:p', label: 'Project 64' },
            ...min3.clusters.map((c) => ({ ...c, parent: 'project:p' })),
          ]
        : min3.clusters;
      const started = performance.now();
      const layout = layoutGraph(min3.nodes, min3.edges, { clusters });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(layout.nodes).toHaveLength(9);
      expect(layout.edges).toHaveLength(8);
    }
  });

  test('random small framed graphs each lay out in moments', () => {
    let slowest = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { nodes, edges, clusters } = framedGraph(seed);
      const started = performance.now();
      const layout = layoutGraph(nodes, edges, { clusters });
      slowest = Math.max(slowest, performance.now() - started);
      expect(layout.nodes).toHaveLength(nodes.length);
    }
    expect(slowest).toBeLessThan(2000);
  }, 120_000);
});
