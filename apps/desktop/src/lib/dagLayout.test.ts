import { describe, expect, it, test } from 'bun:test';

import {
  DAG_NODE_HEIGHT,
  DAG_NODE_WIDTH,
  dagLayout,
  type DagTask,
  dagWaves,
  fitNodeWidth,
} from './dagLayout';

// dagLayout takes its own minimal `DagTask` shape rather than a full TaskDoc, so the fixture
// is exactly the fields the layout reads.
function makeTask(
  id: string,
  blockedBy: string[] = [],
  created = '2026-01-01T00:00:00.000Z',
  status = 'ready'
): DagTask {
  return { id, title: `Task ${id}`, status, created, blockedBy };
}

function layerOf(nodes: ReturnType<typeof dagLayout>['nodes'], id: string) {
  return nodes.find((n) => n.id === id)?.layer;
}

function xOf(nodes: ReturnType<typeof dagLayout>['nodes'], id: string) {
  return nodes.find((n) => n.id === id)?.x;
}

describe('dagLayout', () => {
  it('renders nothing for an empty task set', () => {
    const result = dagLayout([]);
    expect(result).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('lays out a singleton task with no edges', () => {
    const result = dagLayout([makeTask('a')]);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.nodes[0].layer).toBe(0);
    expect(result.nodes[0].width).toBe(DAG_NODE_WIDTH);
    expect(result.nodes[0].height).toBe(DAG_NODE_HEIGHT);
  });

  it('a chain lays out each task one layer deeper than its blocker', () => {
    // c blocked by b, b blocked by a: a -> b -> c
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    const c = makeTask('c', ['b']);
    const result = dagLayout([a, b, c]);

    expect(layerOf(result.nodes, 'a')).toBe(0);
    expect(layerOf(result.nodes, 'b')).toBe(1);
    expect(layerOf(result.nodes, 'c')).toBe(2);
    expect(result.edges).toHaveLength(2);
    expect(result.edges).toContainEqual({ from: 'a', to: 'b' });
    expect(result.edges).toContainEqual({ from: 'b', to: 'c' });

    // A single-file chain has no sibling to barycenter away from — every node shares a column.
    expect(xOf(result.nodes, 'a')).toBe(xOf(result.nodes, 'b'));
    expect(xOf(result.nodes, 'b')).toBe(xOf(result.nodes, 'c'));
  });

  it('a diamond gives both middle tasks the same layer and distinct columns', () => {
    // a blocks b and c; d is blocked by both b and c.
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    const c = makeTask('c', ['a']);
    const d = makeTask('d', ['b', 'c']);
    const result = dagLayout([a, b, c, d]);

    expect(layerOf(result.nodes, 'a')).toBe(0);
    expect(layerOf(result.nodes, 'b')).toBe(1);
    expect(layerOf(result.nodes, 'c')).toBe(1);
    // Longest-path layering: d must sit below both its blockers, not just one.
    expect(layerOf(result.nodes, 'd')).toBe(2);
    expect(result.edges).toHaveLength(4);

    // b and c share a layer but must not overlap in x.
    expect(xOf(result.nodes, 'b')).not.toBe(xOf(result.nodes, 'c'));
  });

  it('lays out two disconnected components without overlapping nodes', () => {
    const a = makeTask('a', [], '2026-01-01T00:00:00.000Z');
    const b = makeTask('b', ['a'], '2026-01-02T00:00:00.000Z');
    const c = makeTask('c', [], '2026-01-03T00:00:00.000Z');
    const d = makeTask('d', ['c'], '2026-01-04T00:00:00.000Z');
    const result = dagLayout([a, b, c, d]);

    expect(layerOf(result.nodes, 'a')).toBe(0);
    expect(layerOf(result.nodes, 'b')).toBe(1);
    expect(layerOf(result.nodes, 'c')).toBe(0);
    expect(layerOf(result.nodes, 'd')).toBe(1);
    expect(result.edges).toHaveLength(2);

    // No two nodes ever share the exact same (x, y) — the two chains must not collide.
    const positions = result.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('never hangs on a cycle and assigns every member a finite layer', () => {
    // a and b block each other — a real cycle, no dangling/self edges involved.
    const a = makeTask('a', ['b']);
    const b = makeTask('b', ['a']);
    const start = Date.now();
    const result = dagLayout([a, b]);
    expect(Date.now() - start).toBeLessThan(1000);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.layer)).toBe(true);
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('a longer cycle through an acyclic entry point still terminates and layers the entry point first', () => {
    // root has no blockers; a/b/c form a cycle, with a also blocked by root.
    const root = makeTask('root');
    const a = makeTask('a', ['root', 'c']);
    const b = makeTask('b', ['a']);
    const c = makeTask('c', ['b']);
    const result = dagLayout([root, a, b, c]);

    expect(layerOf(result.nodes, 'root')).toBe(0);
    // a is reachable from root in one hop, regardless of how the a/b/c cycle resolves.
    expect(layerOf(result.nodes, 'a')).toBeGreaterThanOrEqual(1);
    expect(result.nodes).toHaveLength(4);
  });

  it('ignores dangling and self-referencing blockedBy ids', () => {
    const a = makeTask('a', ['a', 'nonexistent']);
    const result = dagLayout([a]);
    expect(result.edges).toHaveLength(0);
    expect(result.nodes[0].layer).toBe(0);
  });

  it('falls back to a grid when there are no edges at all', () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      makeTask(String(i), [], `2026-01-0${i + 1}T00:00:00.000Z`)
    );
    const result = dagLayout(tasks);

    expect(result.edges).toHaveLength(0);
    expect(result.nodes).toHaveLength(7);
    // More than one row: not squeezed into a single, absurdly long line.
    const rows = new Set(result.nodes.map((n) => n.y));
    expect(rows.size).toBeGreaterThan(1);
    // Every node still gets a well-formed, unique position.
    const positions = result.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(7);
  });

  it('produces deterministic output across repeated calls on the same input', () => {
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    const c = makeTask('c', ['a']);
    const d = makeTask('d', ['b', 'c']);
    const tasks = [d, c, b, a]; // deliberately out of natural order
    const first = dagLayout(tasks);
    const second = dagLayout(tasks);
    expect(second).toEqual(first);
  });

  it('breaks ties deterministically by created date, then id', () => {
    const older = makeTask('z', [], '2026-01-01T00:00:00.000Z');
    const newer = makeTask('a', [], '2026-01-02T00:00:00.000Z');
    const result = dagLayout([newer, older]);
    // Older task sorts first within the shared layer-0 row.
    expect(xOf(result.nodes, 'z')).toBeLessThan(xOf(result.nodes, 'a') ?? 0);
  });
});

describe('dagWaves', () => {
  const t = (id: string, blockedBy: string[] = []) => ({
    id,
    title: id,
    status: 'ready',
    created: '2026-01-01',
    blockedBy,
  });

  test('a task’s wave is one past its deepest blocker', () => {
    const waves = dagWaves([t('a'), t('b', ['a']), t('c', ['a', 'b']), t('d')]);
    expect(Object.fromEntries(waves)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  test('a set with no edges is a single wave, not a wrapped grid', () => {
    const waves = dagWaves(Array.from({ length: 12 }, (_, i) => t(`t${i}`)));
    expect(new Set(waves.values())).toEqual(new Set([0]));
  });

  test('blockers outside the set and self-references are ignored', () => {
    const waves = dagWaves([t('a', ['a', 'outside'])]);
    expect(waves.get('a')).toBe(0);
  });
});

describe('left-to-right layout', () => {
  const at = (layout: ReturnType<typeof dagLayout>, id: string) => {
    const node = layout.nodes.find((n) => n.id === id);
    if (node === undefined) throw new Error(`no node ${id}`);
    return { x: node.x, y: node.y };
  };

  it('puts each layer in its own column, left to right', () => {
    const layout = dagLayout(
      [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])],
      { direction: 'LR' }
    );
    const [a, b, c] = ['a', 'b', 'c'].map((id) => at(layout, id));
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(new Set([a.y, b.y, c.y]).size).toBe(1);
  });

  it('stacks a layer’s nodes down its column', () => {
    const layout = dagLayout(
      [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a'])],
      { direction: 'LR' }
    );
    expect(at(layout, 'b').x).toBe(at(layout, 'c').x);
    expect(at(layout, 'b').y).not.toBe(at(layout, 'c').y);
  });

  it('wraps after the given number of columns into a band below', () => {
    const chain = Array.from({ length: 8 }, (_, i) =>
      makeTask(`n${i}`, i === 0 ? [] : [`n${i - 1}`])
    );
    const layout = dagLayout(chain, { direction: 'LR', wrap: 6 });
    expect(at(layout, 'n6').x).toBe(at(layout, 'n0').x);
    expect(at(layout, 'n6').y).toBeGreaterThan(at(layout, 'n5').y);
    expect(layout.width).toBeLessThan(7 * (DAG_NODE_WIDTH + 48));
  });

  it('top-to-bottom stays the default and does not move', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a'])];
    expect(dagLayout(tasks)).toEqual(dagLayout(tasks, { direction: 'TB' }));
    expect(at(dagLayout(tasks), 'b').y).toBe(
      at(dagLayout(tasks), 'a').y + DAG_NODE_HEIGHT + 64
    );
  });
});

describe('fitNodeWidth', () => {
  const opts = { direction: 'LR' as const, wrap: 6, min: 200, max: 400 };

  it('fills the space across the columns the layout will draw', () => {
    const chain = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])];
    const width = fitNodeWidth(chain, { ...opts, available: 1000 });
    const layout = dagLayout(chain, { ...opts, nodeWidth: width });
    expect(width).toBeGreaterThan(200);
    expect(layout.width).toBeLessThanOrEqual(1000);
    expect(layout.width).toBeGreaterThan(1000 - 3);
  });

  it('clamps to the minimum and maximum', () => {
    const chain = Array.from({ length: 6 }, (_, i) =>
      makeTask(`n${i}`, i === 0 ? [] : [`n${i - 1}`])
    );
    expect(fitNodeWidth(chain, { ...opts, available: 600 })).toBe(200);
    expect(fitNodeWidth([makeTask('a')], { ...opts, available: 2000 })).toBe(
      400
    );
  });

  it('counts columns of the no-edges grid when nothing waits', () => {
    const flat = [makeTask('a'), makeTask('b')];
    const width = fitNodeWidth(flat, { ...opts, available: 600 });
    expect(dagLayout(flat, { ...opts, nodeWidth: width }).width).toBe(600);
  });
});

describe('layout cost', () => {
  // A seeded random DAG: each node waits on up to three earlier ones.
  function randomDag(n: number): DagTask[] {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    return Array.from({ length: n }, (_, i) => {
      const blockers = new Set<string>();
      for (let k = 0; k < 3 && i > 0; k++) {
        blockers.add(`t${Math.floor(rand() * i)}`);
      }
      return makeTask(
        `t${i}`,
        [...blockers],
        `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`
      );
    });
  }

  // Generous budgets: these guard against quadratic blow-ups, not machine speed.
  test.each([
    [64, 50],
    [200, 100],
    [600, 300],
    [2000, 1500],
  ])('%p nodes lay out in under %pms', (n, budget) => {
    const tasks = randomDag(n);
    const start = performance.now();
    const layout = dagLayout(tasks, { direction: 'LR', wrap: 6 });
    dagWaves(tasks);
    expect(performance.now() - start).toBeLessThan(budget);
    expect(layout.nodes).toHaveLength(n);
  });
});
