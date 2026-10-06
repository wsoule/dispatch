import type { TaskListItem } from '@dispatch-foo/core/browser';

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
export function dagTaskFromDoc(doc: TaskListItem): DagTask {
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

/** Top to bottom (layers are rows) or left to right (layers are columns). */
export type DagDirection = 'TB' | 'LR';

interface LayoutOptions extends NodeDims {
  direction: DagDirection;
  /** Left to right only: after this many columns, continue in a band below. */
  wrap: number | null;
}

// Left to right leaves room between columns for an edge's count label.
const GAP_LR_X = 72;
const GAP_LR_Y = 24;
const BAND_GAP = 48;

// A binary min-heap; the zero-in-degree pool pops its least task without re-sorting.
class MinHeap<T> {
  private items: T[] = [];
  private readonly less: (a: T, b: T) => number;
  constructor(less: (a: T, b: T) => number) {
    this.less = less;
  }
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let least = i;
        if (l < items.length && this.less(items[l], items[least]) < 0)
          least = l;
        if (r < items.length && this.less(items[r], items[least]) < 0)
          least = r;
        if (least === i) break;
        [items[i], items[least]] = [items[least], items[i]];
        i = least;
      }
    }
    return top;
  }
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

  // The zero-in-degree pool, popped in (created, id) order — the same order computeStack's
  // "re-sort the pool each pop" gives, so every downstream layer/position decision is
  // fully deterministic, without the sort per pop.
  const queue = new MinHeap<DagTask>(byCreatedThenId);
  const queued = new Set<string>();
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) {
      queue.push(t);
      queued.add(t.id);
    }
  }

  while (queue.size > 0) {
    const doc = queue.pop();
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
  opts: LayoutOptions
): Map<string, Position> {
  const maxLayer = Math.max(...tasks.map((t) => layer.get(t.id) ?? 0));
  const byLayer: DagTask[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const t of tasks) byLayer[layer.get(t.id) ?? 0].push(t);

  // A node's slot within its layer; positions follow from layer and slot.
  const slots = new Map<string, number>();
  for (let l = 0; l <= maxLayer; l++) {
    const scored = byLayer[l].map((doc) => {
      const blockerXs = (blockersOf.get(doc.id) ?? [])
        .map((id) => slots.get(id))
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
      slots.set(doc.id, col);
    });
  }
  const widest = Math.max(...byLayer.map((nodes) => nodes.length));
  const positions = new Map<string, Position>();
  for (const t of tasks) {
    const l = layer.get(t.id) ?? 0;
    const slot = slots.get(t.id) ?? 0;
    positions.set(t.id, place(l, slot, widest, opts));
  }
  return positions;
}

// Where a node in layer `l`, slot `slot` sits. Left to right wraps every `wrap` layers
// into a band below, each band as tall as the widest layer.
function place(
  l: number,
  slot: number,
  widest: number,
  opts: LayoutOptions
): Position {
  if (opts.direction === 'TB') {
    return {
      x: PADDING + slot * (opts.nodeWidth + GAP_X),
      y: PADDING + l * (opts.nodeHeight + GAP_Y),
    };
  }
  const band = opts.wrap === null ? 0 : Math.floor(l / opts.wrap);
  const column = opts.wrap === null ? l : l % opts.wrap;
  const bandHeight = widest * (opts.nodeHeight + GAP_LR_Y) + BAND_GAP;
  return {
    x: PADDING + column * (opts.nodeWidth + GAP_LR_X),
    y: PADDING + band * bandHeight + slot * (opts.nodeHeight + GAP_LR_Y),
  };
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
 * The real dependency edges among `tasks`, both ways: `blockedBy` entries pointing outside
 * the set (or at the task itself) are dropped — the rule every consumer of the layering
 * shares, so a graph, its waves and the stack rail agree on what a dependency is.
 */
function dependencyMaps(tasks: DagTask[]): {
  byId: Map<string, DagTask>;
  blockersOf: Map<string, string[]>;
  dependentsOf: Map<string, string[]>;
} {
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
  return { byId, blockersOf, dependentsOf };
}

/**
 * Each task's wave: its 0-based layer in the longest-path (Kahn) layering the graph draws
 * its columns from — wave 0 has no blockers in the set, wave n waits on something in wave
 * n-1. Unlike `dagLayout`, a set with no edges is one wave rather than a wrapped grid. What
 * a fan-out's wave bar and the Flight Plan both count in.
 */
export function dagWaves(tasks: DagTask[]): Map<string, number> {
  const { byId, blockersOf, dependentsOf } = dependencyMaps(tasks);
  return computeLayers(tasks, byId, blockersOf, dependentsOf);
}

/**
 * A node width that spreads the layout's columns across `available` pixels, clamped to
 * [min, max], so a few nodes fill the space and many stay readable and scroll instead.
 */
export function fitNodeWidth(
  tasks: DagTask[],
  opts: {
    available: number;
    direction: DagDirection;
    wrap: number | null;
    min: number;
    max: number;
  }
): number {
  if (tasks.length === 0 || !(opts.available > 0)) return opts.min;
  const { byId, blockersOf, dependentsOf } = dependencyMaps(tasks);
  const hasEdges = [...blockersOf.values()].some((b) => b.length > 0);
  let columns: number;
  let gap = GAP_X;
  if (!hasEdges) {
    columns = Math.min(GRID_COLUMNS, tasks.length);
  } else {
    const layers = computeLayers(tasks, byId, blockersOf, dependentsOf);
    if (opts.direction === 'LR') {
      const depth = Math.max(...layers.values()) + 1;
      columns = opts.wrap === null ? depth : Math.min(depth, opts.wrap);
      gap = GAP_LR_X;
    } else {
      const perLayer = new Map<number, number>();
      for (const l of layers.values()) {
        perLayer.set(l, (perLayer.get(l) ?? 0) + 1);
      }
      columns = Math.max(...perLayer.values());
    }
  }
  const fit = Math.floor(
    (opts.available - PADDING * 2 - (columns - 1) * gap) / columns
  );
  return Math.max(opts.min, Math.min(opts.max, fit));
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
  opts?: Partial<LayoutOptions>
): DagLayoutResult {
  if (tasks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const dims: LayoutOptions = {
    nodeWidth: opts?.nodeWidth ?? DAG_NODE_WIDTH,
    nodeHeight: opts?.nodeHeight ?? DAG_NODE_HEIGHT,
    direction: opts?.direction ?? 'TB',
    wrap: opts?.wrap ?? null,
  };

  const { byId, blockersOf, dependentsOf } = dependencyMaps(tasks);

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
