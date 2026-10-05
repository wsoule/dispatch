import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import { describe, expect, it } from 'bun:test';

import { type BranchLayout, branchLayout as layoutWith } from './branchLayout';
import type { DagTask } from './dagLayout';

// These cases use the built-in statuses; the mirrored-workflow case lives in
// statusTypeSurfaces.test.tsx.
function branchLayout(tasks: DagTask[]): BranchLayout {
  return layoutWith(tasks, DEFAULT_STATUS_MODEL);
}

// The layout only reads DagTask's five fields, so the fixture is exactly those.
function makeTask(
  id: string,
  blockedBy: string[] = [],
  created = '2026-01-01T00:00:00.000Z',
  status = 'ready'
): DagTask {
  return { id, title: `Task ${id}`, status, created, blockedBy };
}

function rowOf(layout: BranchLayout, id: string) {
  return layout.rows.find((r) => r.id === id)?.row;
}

function laneOf(layout: BranchLayout, id: string) {
  return layout.rows.find((r) => r.id === id)?.lane;
}

function orderOf(layout: BranchLayout) {
  return layout.rows.map((r) => r.id);
}

// Every real edge must point downward: the blocker's row above the dependent's.
function expectBlockersFirst(layout: BranchLayout) {
  for (const edge of layout.edges) {
    expect(edge.fromRow).toBeLessThan(edge.toRow);
  }
}

describe('branchLayout', () => {
  it('returns an empty layout for an empty set', () => {
    expect(branchLayout([])).toEqual({
      rows: [],
      edges: [],
      laneCount: 0,
      path: [],
      pathSummary: { remaining: 0, total: 0, nextId: null },
    });
  });

  it('lays a set with no real edges out as a single trunk', () => {
    const layout = branchLayout([
      makeTask('c', [], '2026-01-03'),
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['outside', 'b'], '2026-01-02'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'b', 'c']);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(layout.laneCount).toBe(1);
    expect(layout.edges).toEqual([]);
    // Nothing chains, so the critical path is one task: the earliest.
    expect(layout.path).toEqual(['a']);
    expect(layout.pathSummary).toEqual({ remaining: 1, total: 1, nextId: 'a' });
  });

  it('collapses duplicate blockedBy ids to one edge', () => {
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['a', 'a'], '2026-01-02'),
    ]);

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: 'a', to: 'b' });
    expect(layout.path).toEqual(['a', 'b']);
  });

  it('an edge-less task in a connected set takes a side lane, not the trunk', () => {
    // a -> b -> c is the path; z was created between a and b and touches nothing.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('z', [], '2026-01-02'),
      makeTask('b', ['a'], '2026-01-03'),
      makeTask('c', ['b'], '2026-01-04'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'z', 'b', 'c']);
    expect(layout.path).toEqual(['a', 'b', 'c']);
    expect(laneOf(layout, 'z')).toBe(1);
    expect(layout.rows.find((r) => r.id === 'z')?.onPath).toBe(false);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(layout.laneCount).toBe(2);
  });

  it('an edge-less task releases its lane at once so the next side branch reuses it', () => {
    // z and w are both one-dot branches between path rows; neither holds lane 1.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('z', [], '2026-01-02'),
      makeTask('w', [], '2026-01-03'),
      makeTask('b', ['a'], '2026-01-04'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'z', 'w', 'b']);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 1, 0]);
    expect(layout.laneCount).toBe(2);
  });

  it('a linear chain is the whole path on the trunk', () => {
    const layout = branchLayout([
      makeTask('c', ['b']),
      makeTask('b', ['a']),
      makeTask('a'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'b', 'c']);
    expectBlockersFirst(layout);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.map((r) => r.onPath)).toEqual([true, true, true]);
    expect(layout.laneCount).toBe(1);
    expect(layout.path).toEqual(['a', 'b', 'c']);
    expect(layout.pathSummary).toEqual({ remaining: 3, total: 3, nextId: 'a' });
    expect(layout.edges).toEqual([
      { from: 'a', to: 'b', fromLane: 0, toLane: 0, fromRow: 0, toRow: 1 },
      { from: 'b', to: 'c', fromLane: 0, toLane: 0, fromRow: 1, toRow: 2 },
    ]);
  });

  it('a diamond forks one side onto a second lane and merges back', () => {
    // a blocks b and c; d is blocked by both.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['a'], '2026-01-02'),
      makeTask('c', ['a'], '2026-01-03'),
      makeTask('d', ['b', 'c'], '2026-01-04'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'b', 'c', 'd']);
    expectBlockersFirst(layout);
    expect(layout.laneCount).toBe(2);
    // Equal-length chains through b and c: the earlier-created side wins the trunk.
    expect(layout.path).toEqual(['a', 'b', 'd']);
    expect(laneOf(layout, 'a')).toBe(0);
    expect(laneOf(layout, 'b')).toBe(0);
    expect(laneOf(layout, 'c')).toBe(1);
    expect(laneOf(layout, 'd')).toBe(0);
    expect(layout.rows.find((r) => r.id === 'c')?.onPath).toBe(false);
    expect(layout.edges).toContainEqual({
      from: 'a',
      to: 'c',
      fromLane: 0,
      toLane: 1,
      fromRow: 0,
      toRow: 2,
    });
    expect(layout.edges).toContainEqual({
      from: 'c',
      to: 'd',
      fromLane: 1,
      toLane: 0,
      fromRow: 2,
      toRow: 3,
    });
    expect(layout.edges).toHaveLength(4);
  });

  it('two independent chains: the longer is the trunk, the other keeps one side lane', () => {
    // a -> b -> c interleaved by creation date with x -> y.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('x', [], '2026-01-02'),
      makeTask('b', ['a'], '2026-01-03'),
      makeTask('y', ['x'], '2026-01-04'),
      makeTask('c', ['b'], '2026-01-05'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'x', 'b', 'y', 'c']);
    expectBlockersFirst(layout);
    expect(layout.path).toEqual(['a', 'b', 'c']);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(layout.laneCount).toBe(2);
    expect(layout.pathSummary).toEqual({ remaining: 3, total: 3, nextId: 'a' });
  });

  it('overlapping side branches never share a lane and free it once merged', () => {
    // Three branches off a all merge into e; f hangs off e after every lane is released.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['a'], '2026-01-02'),
      makeTask('c', ['a'], '2026-01-03'),
      makeTask('d', ['a'], '2026-01-04'),
      makeTask('e', ['b', 'c', 'd'], '2026-01-05'),
      makeTask('f', ['a'], '2026-01-06'),
    ]);

    expect(orderOf(layout)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(laneOf(layout, 'b')).toBe(0);
    expect(laneOf(layout, 'c')).toBe(1);
    expect(laneOf(layout, 'd')).toBe(2);
    expect(laneOf(layout, 'e')).toBe(0);
    // c and d released their lanes at e, so f takes the lowest one again.
    expect(laneOf(layout, 'f')).toBe(1);
    expect(layout.laneCount).toBe(3);
  });

  it("a side branch continues its blocker's lane rather than forking a new one", () => {
    // Trunk a -> b -> c -> d; side x -> y hangs off a and never merges back.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('x', ['a'], '2026-01-02'),
      makeTask('b', ['a'], '2026-01-03'),
      makeTask('y', ['x'], '2026-01-04'),
      makeTask('c', ['b'], '2026-01-05'),
      makeTask('d', ['c'], '2026-01-06'),
    ]);

    expect(layout.path).toEqual(['a', 'b', 'c', 'd']);
    expect(laneOf(layout, 'x')).toBe(1);
    expect(laneOf(layout, 'y')).toBe(1);
    expect(layout.laneCount).toBe(2);
    expect(layout.edges).toContainEqual({
      from: 'x',
      to: 'y',
      fromLane: 1,
      toLane: 1,
      fromRow: 1,
      toRow: 3,
    });
  });

  it('done tasks drop off the path but the chain they fed stays on the trunk', () => {
    // a (landed) -> b (landed) -> c -> d, plus a longer chain of done work elsewhere.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01', 'landed'),
      makeTask('b', ['a'], '2026-01-02', 'landed'),
      makeTask('c', ['b'], '2026-01-03'),
      makeTask('d', ['c'], '2026-01-04'),
      makeTask('p', [], '2026-01-05', 'landed'),
      makeTask('q', ['p'], '2026-01-06', 'dropped'),
      makeTask('r', ['q'], '2026-01-07', 'landed'),
      makeTask('s', ['r'], '2026-01-08', 'landed'),
    ]);

    expect(layout.path).toEqual(['c', 'd']);
    expect(layout.rows.map((r) => r.onPath)).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // Path tasks' done ancestors make up the rest of the trunk's total.
    expect(layout.pathSummary).toEqual({ remaining: 2, total: 4, nextId: 'c' });
    expect(laneOf(layout, 'a')).toBe(0);
    expect(laneOf(layout, 'b')).toBe(0);
    expect(laneOf(layout, 'p')).toBe(1);
    expect(laneOf(layout, 's')).toBe(1);
  });

  it('a done chain that never feeds the path stays out of the trunk total', () => {
    // p -> q -> r all landed and disconnected from x -> y, the only unfinished chain.
    const layout = branchLayout([
      makeTask('p', [], '2026-01-01', 'landed'),
      makeTask('q', ['p'], '2026-01-02', 'landed'),
      makeTask('r', ['q'], '2026-01-03', 'landed'),
      makeTask('x', [], '2026-01-04'),
      makeTask('y', ['x'], '2026-01-05'),
    ]);

    expect(layout.path).toEqual(['x', 'y']);
    expect(layout.pathSummary).toEqual({ remaining: 2, total: 2, nextId: 'x' });
    expect(layout.rows.map((r) => r.lane)).toEqual([1, 1, 1, 0, 0]);
  });

  it('a chain through a done task counts only its unfinished tail', () => {
    // x -> y -> z is three unfinished; a -> b(landed) -> c -> d has only c, d left.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['a'], '2026-01-02', 'landed'),
      makeTask('c', ['b'], '2026-01-03'),
      makeTask('d', ['c'], '2026-01-04'),
      makeTask('x', [], '2026-01-05'),
      makeTask('y', ['x'], '2026-01-06'),
      makeTask('z', ['y'], '2026-01-07'),
    ]);

    expect(layout.path).toEqual(['x', 'y', 'z']);
    expect(layout.pathSummary.remaining).toBe(3);
  });

  it('a fully landed milestone has an empty path and remaining 0', () => {
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01', 'landed'),
      makeTask('b', ['a'], '2026-01-02', 'landed'),
      makeTask('c', ['b'], '2026-01-03', 'dropped'),
    ]);

    expect(layout.path).toEqual([]);
    expect(layout.rows.every((r) => !r.onPath)).toBe(true);
    expect(layout.pathSummary).toEqual({
      remaining: 0,
      total: 3,
      nextId: null,
    });
    // The done chain still draws as one trunk line.
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  });

  it('tolerates a cycle: nothing throws and every task keeps a row', () => {
    // a <-> b cycle, c downstream of b, d independent.
    const tasks = [
      makeTask('a', ['b'], '2026-01-01'),
      makeTask('b', ['a'], '2026-01-02'),
      makeTask('c', ['b'], '2026-01-03'),
      makeTask('d', [], '2026-01-04'),
    ];

    const layout = branchLayout(tasks);
    expect(orderOf(layout).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(layout.rows.map((r) => r.row)).toEqual([0, 1, 2, 3]);
    // The cycle is broken at its earliest member; everything below it still follows its blocker.
    expect(rowOf(layout, 'a')).toBeLessThan(rowOf(layout, 'b') ?? -1);
    expect(rowOf(layout, 'b')).toBeLessThan(rowOf(layout, 'c') ?? -1);
    expect(layout.edges).toHaveLength(3);
    // Only the cycle's back-edge points upward: b blocks a but sits below it.
    const upward = layout.edges.filter((e) => e.fromRow > e.toRow);
    expect(upward).toHaveLength(1);
    expect(upward[0]).toMatchObject({ from: 'b', to: 'a' });
    expect(layout.path).toEqual(['a', 'b', 'c']);
    // a still has an unfinished blocker (the back-edge), so nothing on the path is ready.
    expect(layout.pathSummary.nextId).toBeNull();
  });

  it('nextId is the first path task whose blockers are all done', () => {
    // a (landed) and x (open) both block b; b -> c.
    const layout = branchLayout([
      makeTask('a', [], '2026-01-01', 'landed'),
      makeTask('x', [], '2026-01-02'),
      makeTask('b', ['a', 'x'], '2026-01-03'),
      makeTask('c', ['b'], '2026-01-04'),
    ]);

    expect(layout.path).toEqual(['x', 'b', 'c']);
    expect(layout.pathSummary.nextId).toBe('x');

    const afterX = branchLayout([
      makeTask('a', [], '2026-01-01', 'landed'),
      makeTask('x', [], '2026-01-02', 'landed'),
      makeTask('b', ['a', 'x'], '2026-01-03'),
      makeTask('c', ['b'], '2026-01-04'),
    ]);
    expect(afterX.path).toEqual(['b', 'c']);
    // The trunk's done prefix is a chain, so only one of b's two done blockers counts.
    expect(afterX.pathSummary).toEqual({ remaining: 2, total: 3, nextId: 'b' });
  });

  it('is deterministic regardless of input order', () => {
    const tasks = [
      makeTask('a', [], '2026-01-01'),
      makeTask('b', ['a'], '2026-01-02'),
      makeTask('c', ['a'], '2026-01-02'),
      makeTask('d', ['b', 'c'], '2026-01-03'),
      makeTask('e', ['d'], '2026-01-04', 'landed'),
    ];
    const forward = JSON.stringify(branchLayout(tasks));
    const reversed = JSON.stringify(branchLayout([...tasks].reverse()));
    expect(reversed).toBe(forward);
    expect(JSON.stringify(branchLayout(tasks))).toBe(forward);
  });
});
