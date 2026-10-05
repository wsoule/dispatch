import type { TaskListItem } from '@dispatch/core/browser';
import { isContainerKind, isValidParentKind } from '@dispatch/core/browser';

/**
 * The containers above a task, outermost first (`Initiative › Project › Milestone ›
 * Parent issue`), following `parent` links. Stops at a missing parent or a cycle.
 */
export function ancestorsOf(
  task: TaskListItem,
  byId: ReadonlyMap<string, TaskListItem>
): TaskListItem[] {
  const chain: TaskListItem[] = [];
  const seen = new Set([task.meta.id]);
  let parentId = task.meta.parent;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    seen.add(parentId);
    chain.push(parent);
    parentId = parent.meta.parent;
  }
  return chain.reverse();
}

/** Every task below `rootId`, through any depth of `parent` links. */
function descendantIds(
  rootId: string,
  tasks: readonly TaskListItem[]
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.meta.parent === null) continue;
    const list = childrenOf.get(t.meta.parent) ?? [];
    list.push(t.meta.id);
    childrenOf.set(t.meta.parent, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const child of childrenOf.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * Where `task` may move: containers of a broader kind, then issues that already have
 * sub-issues, never itself or anything beneath it (which would make a cycle). Listing
 * every plain issue in a 2000-task project would bury the few real destinations.
 */
export function parentCandidates(
  task: TaskListItem,
  tasks: readonly TaskListItem[],
  parentIds: ReadonlySet<string>
): TaskListItem[] {
  const below = descendantIds(task.meta.id, tasks);
  const containers: TaskListItem[] = [];
  const parents: TaskListItem[] = [];
  for (const t of tasks) {
    const id = t.meta.id;
    if (id === task.meta.id || below.has(id) || t.meta.archivedAt !== undefined)
      continue;
    if (!isValidParentKind(task.meta.kind, t.meta.kind)) continue;
    if (isContainerKind(t.meta.kind)) containers.push(t);
    else if (parentIds.has(id)) parents.push(t);
  }
  return [...containers, ...parents];
}
