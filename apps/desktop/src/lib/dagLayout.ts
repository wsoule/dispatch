import type { TaskListItem } from '@dispatch-foo/core/browser';

/**
 * The minimal node shape the dependency layering needs — deliberately not `TaskDoc`, so
 * anything with dependency structure can be layered or drawn as a branch graph: real tasks
 * (via `dagTaskFromDoc`), a plan's still-unconfirmed drafts (index-keyed, no ids minted
 * yet), or whatever the next surface is.
 * `created` is only a deterministic tie-break key; any stable sortable string works.
 */
export interface DagTask {
  id: string;
  title: string;
  status: string;
  created: string;
  blockedBy: string[];
}

/** Adapts a real task to the layering's minimal shape. */
export function dagTaskFromDoc(doc: TaskListItem): DagTask {
  return {
    id: doc.meta.id,
    title: doc.meta.title,
    status: doc.meta.status,
    created: doc.meta.created,
    blockedBy: doc.meta.blockedBy,
  };
}

// Deterministic tie-break shared in spirit with core's `computeStack`: created date first,
// then id, so two calls over the same task set always produce identical waves — no jitter
// between renders when created dates collide (or are literally equal, in fixtures).
function byCreatedThenId(a: DagTask, b: DagTask): number {
  const byCreated = a.created.localeCompare(b.created);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

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
 * its blockers (real edges only — see `dependencyMaps`), computed so every blocker's
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
 * The real dependency edges among `tasks`, both ways: `blockedBy` entries pointing outside
 * the set (or at the task itself) are dropped — the rule every consumer of the layering
 * shares, so the waves, the Flight Plan and the stack rail agree on what a dependency is.
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
 * Each task's wave: its 0-based layer in the longest-path (Kahn) layering — wave 0 has no
 * blockers in the set, wave n waits on something in wave n-1, and a set with no edges is a
 * single wave. What a fan-out's wave bar and the Flight Plan both count in.
 */
export function dagWaves(tasks: DagTask[]): Map<string, number> {
  const { byId, blockersOf, dependentsOf } = dependencyMaps(tasks);
  return computeLayers(tasks, byId, blockersOf, dependentsOf);
}
