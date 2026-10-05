import type {
  StatusModel,
  TaskListItem,
  TaskMeta,
} from '@dispatch-foo/core/browser';
import { isContainerKind, isUnstartedStatus } from '@dispatch-foo/core/browser';

// The server's list order (packages/server/src/cache.ts): created, then id.
function before(a: TaskMeta, b: TaskMeta): boolean {
  if (a.created !== b.created) return a.created < b.created;
  return a.id < b.id;
}

/** The cached task list with `meta` in place of its old entry, or inserted where the
 * server would list it — so a single task's refetch never needs the whole list again.
 * An older `updated` than the cached one is a stale response and leaves the list as is. */
export function upsertTaskListItem(
  list: TaskListItem[],
  meta: TaskMeta
): TaskListItem[] {
  const index = list.findIndex((t) => t.meta.id === meta.id);
  if (index !== -1) {
    if (meta.updated < list[index].meta.updated) return list;
    const next = [...list];
    next[index] = { meta };
    return next;
  }
  let at = list.length;
  while (at > 0 && before(meta, list[at - 1].meta)) at--;
  return [...list.slice(0, at), { meta }, ...list.slice(at)];
}

/** Whether two lists hold the same items in the same order, by identity. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** The cached task list without `id` — the task was deleted. */
export function removeTaskListItem(
  list: TaskListItem[],
  id: string
): TaskListItem[] {
  return list.filter((t) => t.meta.id !== id);
}

/** Whether a change to task `id` can move a fan-out's progress: it sits under a
 * container before or after (`next`, null once deleted), is a container, has
 * children, or blocks a task in a fan-out (whose phase reads "waiting on" its
 * blockers). With no list cached, it might. */
export function touchesFanout(
  list: readonly TaskListItem[] | undefined,
  id: string,
  next: TaskMeta | null
): boolean {
  if (list === undefined) return true;
  if (next !== null && (next.parent !== null || isContainerKind(next.kind))) {
    return true;
  }
  for (const { meta } of list) {
    if (meta.parent === id) return true;
    const inFanout = meta.parent !== null || isContainerKind(meta.kind);
    if (inFanout && (meta.id === id || meta.blockedBy.includes(id))) {
      return true;
    }
  }
  return false;
}

/** The list with each task in `dispatching` that is still waiting to start shown in the
 * model's dispatched status — a dispatch drawn as started before the daemon's own change
 * arrives. The same array when nothing changes. */
export function withDispatching(
  list: TaskListItem[],
  dispatching: ReadonlyMap<string, unknown>,
  model: StatusModel
): TaskListItem[] {
  if (dispatching.size === 0) return list;
  const status = model.roles.dispatched;
  let changed = false;
  const next = list.map((task) => {
    if (
      !dispatching.has(task.meta.id) ||
      !isUnstartedStatus(task.meta.status, model)
    ) {
      return task;
    }
    changed = true;
    return { ...task, meta: { ...task.meta, status } };
  });
  return changed ? next : list;
}
