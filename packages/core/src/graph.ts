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
