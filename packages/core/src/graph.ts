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
