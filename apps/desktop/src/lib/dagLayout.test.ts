import type { TaskDoc } from '@dispatch/core/browser';
import { describe, expect, it } from 'bun:test';

import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, dagLayout } from './dagLayout';

// Mirrors taskGraph.test.ts's fixture convention — a minimal TaskDoc with just the fields
// dagLayout reads (id, title, status, blockedBy, created).
function makeTask(
  id: string,
  blockedBy: string[] = [],
  created = '2026-01-01T00:00:00.000Z',
  status = 'todo'
): TaskDoc {
  return {
    meta: {
      id,
      title: `Task ${id}`,
      status,
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy,
      labels: [],
      priority: 'none',
      assignee: 'none',
      created,
      updated: created,
      external: null,
      selfReview: false,
      writes: [],
      risk: 'routine',
      model: null,
    },
    body: '',
  };
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
