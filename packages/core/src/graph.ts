import type { Priority, TaskDoc } from './types.js';

export const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function isDone(t: TaskDoc): boolean {
  return t.meta.status === 'done' || t.meta.status === 'cancelled';
}

/**
 * Tasks safe to start now: kind=task, status=todo, all blockers done.
 * Dangling blocker ids (no task in the set) do not block; `doctor` reports them.
 */
export function readyTasks(tasks: TaskDoc[]): TaskDoc[] {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  return tasks
    .filter((t) => t.meta.kind === 'task' && t.meta.status === 'todo')
    .filter((t) =>
      t.meta.blockedBy.every((dep) => {
        const d = byId.get(dep);
        return d === undefined || isDone(d);
      })
    )
    .sort((a, b) => {
      const byPriority =
        PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority];
      return byPriority !== 0
        ? byPriority
        : a.meta.created.localeCompare(b.meta.created);
    });
}

/**
 * Finds cycles in the blockedBy graph across `tasks`. Adapted from the
 * planner's proposal-time `assertAcyclic` (packages/server/src/orchestrator/
 * planner.ts), which does a three-color (unvisited/visiting/done) DFS over
 * proposal array indices just to detect *that* a cycle exists before any
 * real id is minted. This walks real task ids instead, and — since `doctor`
 * needs to report which ids form the cycle, not just that one exists — keeps
 * a live path stack and slices out the cycle segment the moment a
 * "visiting" node is revisited.
 *
 * A self-reference (blockedBy including the task's own id) and a dangling
 * blockedBy (pointing at no task in `tasks`) are both reported as their own
 * doctor issues, so neither counts as a cycle edge here.
 *
 * Returns one path per distinct cycle found, each ending back at its own
 * start id, e.g. ['t-aaaaaa', 't-bbbbbb', 't-aaaaaa']. A DFS forest only
 * reports the first revisit it walks into per cycle — pathological graphs
 * with multiple overlapping cycles may surface more than one path touching
 * the same ids, which is fine for reporting purposes.
 */
export function findDependencyCycles(tasks: TaskDoc[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  const UNVISITED = 0;
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const path: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    const current = state.get(id) ?? UNVISITED;
    if (current === DONE) return;
    if (current === VISITING) {
      const start = path.indexOf(id);
      cycles.push([...path.slice(start), id]);
      return;
    }
    state.set(id, VISITING);
    path.push(id);
    for (const dep of byId.get(id)?.meta.blockedBy ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      visit(dep);
    }
    path.pop();
    state.set(id, DONE);
  };

  for (const t of tasks) visit(t.meta.id);
  return cycles;
}

export interface TaskStack {
  /** Task ids of the stack, topologically ordered: blockers before dependents. */
  order: string[];
  /** Position of the requested task within `order` (0-based). */
  index: number;
}

/**
 * The "stack" a task belongs to: the connected component of the blockedBy
 * graph containing `taskId` (treating edges as undirected for membership),
 * topologically sorted so blockers come before their dependents. Diamonds are
 * linearized (ties broken by created date, then id) — the rail UI renders a
 * single column; true branching is the deferred DAG view's job. Cycle members
 * can never all reach in-degree zero, so any leftovers are appended in
 * created-date order rather than dropped — `doctor` reports the cycle itself.
 * Returns null for an unknown id or a task with no stack edges (a stack of
 * one is not a stack).
 */
export function computeStack(
  tasks: TaskDoc[],
  taskId: string
): TaskStack | null {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  if (!byId.has(taskId)) return null;

  // Undirected adjacency over real (non-dangling, non-self) blockedBy edges.
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
    (neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
  };
  for (const t of tasks) {
    for (const dep of t.meta.blockedBy) {
      if (dep !== t.meta.id && byId.has(dep)) link(t.meta.id, dep);
    }
  }

  // BFS out the component containing taskId.
  const component = new Set<string>([taskId]);
  const frontier = [taskId];
  while (frontier.length > 0) {
    const id = frontier.pop()!;
    for (const next of neighbors.get(id) ?? []) {
      if (!component.has(next)) {
        component.add(next);
        frontier.push(next);
      }
    }
  }
  if (component.size < 2) return null;

  // Kahn's algorithm restricted to the component, deterministic order: the
  // zero-in-degree pool is re-sorted by (created, id) each pop.
  // Use Sets to track placed and pooled ids for O(1) membership checks,
  // avoiding O(n²) worst-case from array.includes() inside the loop.
  const byCreated = (a: string, b: string) => {
    const ta = byId.get(a)!.meta;
    const tb = byId.get(b)!.meta;
    const comparison = ta.created.localeCompare(tb.created);
    return comparison !== 0 ? comparison : a.localeCompare(b);
  };
  const inDegree = new Map<string, number>();
  for (const id of component) {
    const deps = new Set(
      byId.get(id)!.meta.blockedBy.filter((d) => component.has(d) && d !== id)
    );
    inDegree.set(id, deps.size);
  }
  const pool = [...component].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  const placed = new Set<string>();
  const pooled = new Set(pool);
  while (pool.length > 0) {
    pool.sort(byCreated);
    const id = pool.shift()!;
    pooled.delete(id);
    order.push(id);
    placed.add(id);
    for (const dependent of component) {
      if (placed.has(dependent) || pooled.has(dependent)) continue;
      const deps = byId.get(dependent)!.meta.blockedBy;
      if (!deps.includes(id)) continue;
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        pool.push(dependent);
        pooled.add(dependent);
      }
    }
  }
  // Cycle leftovers: never reached in-degree 0.
  const leftovers = [...component].filter((id) => !placed.has(id));
  leftovers.sort(byCreated);
  order.push(...leftovers);

  return { order, index: order.indexOf(taskId) };
}
