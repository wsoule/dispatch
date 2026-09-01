import type { TaskDoc } from '@dispatch/core/browser';

/**
 * The minimal node shape the layout needs — deliberately not `TaskDoc`, so anything with
 * dependency structure can render as a graph: real tasks (via `dagTaskFromDoc`), a plan's
 * still-unconfirmed drafts (index-keyed, no ids minted yet), or whatever the next surface is.
 * `created` is only a deterministic tie-break key; any stable sortable string works.
 */
export interface DagTask {
  id: string;
  title: string;
  status: string;
  created: string;
  blockedBy: string[];
}

/** Adapts a real task to the layout's minimal shape. */
export function dagTaskFromDoc(doc: TaskDoc): DagTask {
  return {
    id: doc.meta.id,
    title: doc.meta.title,
    status: doc.meta.status,
    created: doc.meta.created,
    blockedBy: doc.meta.blockedBy,
  };
}

// Fixed node footprint for every box in the epic DAG — generous enough for a truncated title
// plus a status line at the 11-13px scale the rest of the app renders task text at, small
// enough that a few dozen tasks (the realistic epic size — see core's `computeStack` comment
// on the same assumption) still fit without absurd zoom.
export const DAG_NODE_WIDTH = 180;
export const DAG_NODE_HEIGHT = 56;

// Gaps between nodes — generous per the design brief so curved edges have somewhere to bend
// without crossing box interiors, and a margin around the whole graph so edges/nodes never sit
// flush against the SVG's own edge.
const GAP_X = 48;
const GAP_Y = 64;
const PADDING = 24;

// How many nodes sit in a row before wrapping to the next — only used by the no-edges grid
// fallback (see `gridLayout` below), where there is no dependency structure to size rows by.
const GRID_COLUMNS = 5;

export interface DagNode {
  id: string;
  title: string;
  status: string;
  /** 0-based depth from the graph's roots (longest path from any blocker-less task). */
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DagEdge {
  /** The blocker (edge source) task id. */
  from: string;
  /** The blocked (edge target/dependent) task id. */
  to: string;
}

export interface DagLayoutResult {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
}

// Deterministic tie-break shared in spirit with core's `computeStack`: created date first,
// then id, so two calls over the same task set always produce byte-identical layouts — no
// jitter between renders when created dates collide (or are literally equal, in fixtures).
function byCreatedThenId(a: DagTask, b: DagTask): number {
  const byCreated = a.created.localeCompare(b.created);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

interface Position {
  x: number;
  y: number;
}

/** Node footprint for one layout run — callers override the defaults when their node
 * rendering has a different fixed size (e.g. DependencyGraph's ContextCard nodes). */
interface NodeDims {
  nodeWidth: number;
  nodeHeight: number;
}

/**
 * Longest-path layering via Kahn's algorithm: a task's layer is one more than the deepest of
 * its blockers (real edges only — see `dagLayout`'s filtering), computed so every blocker's
 * layer is finalized (all of *its* predecessors have already updated it) before any dependent
 * reads it. A real cycle can never fully drain the in-degree queue; whatever ids are left over
 * are assigned layers afterward in `(created, id)` order, each using whichever of its blockers
 * happen to already have a resolved layer (a still-mid-cycle blocker contributes nothing) —
 * this is what breaks the cycle, in one bounded extra pass rather than ever recursing into it.
 */
function computeLayers(
  tasks: DagTask[],
  byId: Map<string, DagTask>,
  blockersOf: Map<string, string[]>,
  dependentsOf: Map<string, string[]>
): Map<string, number> {
  const layer = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    inDegree.set(t.id, (blockersOf.get(t.id) ?? []).length);
  }

  // The zero-in-degree pool, re-sorted by (created, id) on every pop — mirrors computeStack's
  // "re-sort the pool each pop" convention so processing order (and therefore every downstream
  // layer/position decision) is fully deterministic.
  let queue = tasks.filter((t) => inDegree.get(t.id) === 0);
  const queued = new Set(queue.map((t) => t.id));

  while (queue.length > 0) {
    queue.sort(byCreatedThenId);
    const doc = queue.shift();
    if (doc === undefined) break;
    queued.delete(doc.id);
    // Roots (no real blockers) never get a layer written by the dependent-update loop below,
    // so they need an explicit default; anything already set here got it from a blocker that
    // was processed earlier in this same pass.
    if (!layer.has(doc.id)) layer.set(doc.id, 0);
    const myLayer = layer.get(doc.id) ?? 0;

    for (const dependentId of dependentsOf.get(doc.id) ?? []) {
      const candidate = myLayer + 1;
      layer.set(dependentId, Math.max(layer.get(dependentId) ?? 0, candidate));
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      const dependentDoc = byId.get(dependentId);
      if (
        remaining === 0 &&
        !queued.has(dependentId) &&
        dependentDoc !== undefined
      ) {
        queue.push(dependentDoc);
        queued.add(dependentId);
      }
    }
  }

  const leftovers = tasks.filter((t) => !layer.has(t.id)).sort(byCreatedThenId);
  for (const doc of leftovers) {
    const blockerLayers = (blockersOf.get(doc.id) ?? [])
      .map((id) => layer.get(id))
      .filter((l): l is number => l !== undefined);
    layer.set(
      doc.id,
      blockerLayers.length > 0 ? Math.max(...blockerLayers) + 1 : 0
    );
  }

  return layer;
}

/**
 * Within-layer ordering: one barycenter pass, processed layer by layer from the top down. Each
 * node's column is chosen by the mean x of its blockers that already have a position — always
 * possible for a blocker in a strictly earlier layer, since layers are handled in increasing
 * order — falling back to `(created, id)` for a node with none (a layer-0 root, or a cycle
 * member whose blockers never resolved to an earlier layer). One pass, no iterative refinement,
 * per the design brief — good enough for the dozens-of-tasks graphs this renders.
 */
function orderWithinLayers(
  tasks: DagTask[],
  layer: Map<string, number>,
  blockersOf: Map<string, string[]>,
  dims: NodeDims
): Map<string, Position> {
  const maxLayer = Math.max(...tasks.map((t) => layer.get(t.id) ?? 0));
  const byLayer: DagTask[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const t of tasks) byLayer[layer.get(t.id) ?? 0].push(t);

  const positions = new Map<string, Position>();
  for (let l = 0; l <= maxLayer; l++) {
    const scored = byLayer[l].map((doc) => {
      const blockerXs = (blockersOf.get(doc.id) ?? [])
        .map((id) => positions.get(id)?.x)
        .filter((x): x is number => x !== undefined);
      const barycenter =
        blockerXs.length > 0
          ? blockerXs.reduce((sum, x) => sum + x, 0) / blockerXs.length
          : null;
      return { doc, barycenter };
    });
    scored.sort((a, b) => {
      if (a.barycenter !== null && b.barycenter !== null) {
        if (a.barycenter !== b.barycenter) return a.barycenter - b.barycenter;
      } else if (a.barycenter !== null) {
        return -1;
      } else if (b.barycenter !== null) {
        return 1;
      }
      return byCreatedThenId(a.doc, b.doc);
    });
    scored.forEach(({ doc }, col) => {
      positions.set(doc.id, {
        x: PADDING + col * (dims.nodeWidth + GAP_X),
        y: PADDING + l * (dims.nodeHeight + GAP_Y),
      });
    });
  }
  return positions;
}

// Fallback for a set of tasks with no real blockedBy edges among them at all: laying every one
// of them out in a single row would (for an epic with a few dozen flat tasks) produce an
// absurdly long, mostly-empty-looking line. Wraps into rows of `GRID_COLUMNS` instead — still
// deterministic (created, id order), still the same node footprint/gaps as the layered case.
function gridLayout(tasks: DagTask[], dims: NodeDims): DagLayoutResult {
  const sorted = [...tasks].sort(byCreatedThenId);
  const nodes: DagNode[] = sorted.map((doc, i) => {
    const col = i % GRID_COLUMNS;
    const row = Math.floor(i / GRID_COLUMNS);
    return {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      layer: row,
      x: PADDING + col * (dims.nodeWidth + GAP_X),
      y: PADDING + row * (dims.nodeHeight + GAP_Y),
      width: dims.nodeWidth,
      height: dims.nodeHeight,
    };
  });
  const cols = Math.min(GRID_COLUMNS, tasks.length);
  const rows = Math.ceil(tasks.length / GRID_COLUMNS);
  return {
    nodes,
    edges: [],
    width: PADDING * 2 + cols * dims.nodeWidth + Math.max(cols - 1, 0) * GAP_X,
    height:
      PADDING * 2 + rows * dims.nodeHeight + Math.max(rows - 1, 0) * GAP_Y,
  };
}

/**
 * Hand-rolled layered ("Sugiyama-style") layout for an epic's dependency graph — no charting
 * library, since an epic's task count tops out in the dozens (see `DAG_NODE_WIDTH`'s comment).
 * `tasks` is expected to be one epic's children; `blockedBy` edges pointing outside that set
 * (or at the task itself) are ignored, the same "real edges only" rule `computeStack` applies,
 * so this view and the stack rail always agree on what counts as a dependency.
 *
 * Two passes — layering (`computeLayers`) then within-layer ordering (`orderWithinLayers`) —
 * both described in their own doc comments. A task set with no real edges at all skips both in
 * favor of `gridLayout`'s plain row-wrapping grid, the design's explicit empty-edges fallback.
 */
export function dagLayout(
  tasks: DagTask[],
  opts?: Partial<NodeDims>
): DagLayoutResult {
  if (tasks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const dims: NodeDims = {
    nodeWidth: opts?.nodeWidth ?? DAG_NODE_WIDTH,
    nodeHeight: opts?.nodeHeight ?? DAG_NODE_HEIGHT,
  };

  const byId = new Map(tasks.map((t) => [t.id, t]));

  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const t of tasks) {
    const real = t.blockedBy.filter((id) => id !== t.id && byId.has(id));
    blockersOf.set(t.id, real);
    for (const blockerId of real) {
      const bucket = dependentsOf.get(blockerId);
      if (bucket !== undefined) bucket.push(t.id);
      else dependentsOf.set(blockerId, [t.id]);
    }
  }

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const blockerId of blockersOf.get(t.id) ?? []) {
      edges.push({ from: blockerId, to: t.id });
    }
  }

  if (edges.length === 0) return gridLayout(tasks, dims);

  const layer = computeLayers(tasks, byId, blockersOf, dependentsOf);
  const positions = orderWithinLayers(tasks, layer, blockersOf, dims);

  const nodes: DagNode[] = tasks.map((doc) => {
    // Every task passed in gets both a layer (computeLayers) and a position
    // (orderWithinLayers) — the fallback is only ever a defensive default, never reachable.
    const pos = positions.get(doc.id) ?? { x: PADDING, y: PADDING };
    return {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      layer: layer.get(doc.id) ?? 0,
      x: pos.x,
      y: pos.y,
      width: dims.nodeWidth,
      height: dims.nodeHeight,
    };
  });

  const maxRight = Math.max(...nodes.map((n) => n.x + n.width));
  const maxBottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    nodes,
    edges,
    width: maxRight + PADDING,
    height: maxBottom + PADDING,
  };
}
