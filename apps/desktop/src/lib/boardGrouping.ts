import type { TaskDoc } from '@dispatch/core';

export interface BoardColumnGroup {
  status: string;
  tasks: TaskDoc[];
}

/** Groups tasks into one bucket per tracker status, in the order the project's
 * `.dispatch/config.yml` lists them (never hardcoded/alphabetical) — the shape the Board
 * view renders one column per. A single pass over `tasks` with a status->bucket map, rather
 * than the old `statuses.map(status => tasks.filter(...))` (O(statuses * tasks)): every task
 * is placed in O(1) once statuses have seeded empty buckets, so this stays linear as either
 * list grows. A task whose status isn't in `statuses` is dropped from the board, matching
 * the previous filter-based behavior. */
export function groupTasksByStatus(
  tasks: TaskDoc[],
  statuses: string[]
): BoardColumnGroup[] {
  const buckets = new Map<string, TaskDoc[]>();
  for (const status of statuses) buckets.set(status, []);
  for (const task of tasks) {
    buckets.get(task.meta.status)?.push(task);
  }
  return statuses.map((status) => ({
    status,
    tasks: buckets.get(status) ?? [],
  }));
}
