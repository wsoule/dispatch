import type { TaskCycle, TaskListItem } from '@dispatch/core/browser';

/** Lookups over one version of the task list that every open task page shares. */
export interface TaskIndex {
  byId: ReadonlyMap<string, TaskListItem>;
  /** Ids some task names as its parent. */
  parentIds: ReadonlySet<string>;
  childrenOf: ReadonlyMap<string, readonly TaskListItem[]>;
  /** Tasks that name each id in `blockedBy`. */
  blocksOf: ReadonlyMap<string, readonly TaskListItem[]>;
  /** Every label in use, sorted. */
  labels: readonly string[];
  /** Every cycle any task names, oldest first. */
  cycles: readonly TaskCycle[];
}

const EMPTY: readonly TaskListItem[] = [];
const cache = new WeakMap<readonly TaskListItem[], TaskIndex>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * One pass over the task list, cached per list version (the query hands out a new array
 * on every change), so opening a task — or following the cursor through twenty — never
 * rescans two thousand tasks to find its children, blockers or the label vocabulary.
 */
export function taskIndexOf(tasks: readonly TaskListItem[]): TaskIndex {
  const cached = cache.get(tasks);
  if (cached !== undefined) return cached;
  const byId = new Map<string, TaskListItem>();
  const childrenOf = new Map<string, TaskListItem[]>();
  const blocksOf = new Map<string, TaskListItem[]>();
  const labels = new Set<string>();
  const cycles = new Map<string, TaskCycle>();
  for (const t of tasks) {
    const meta = t.meta;
    byId.set(meta.id, t);
    if (meta.parent !== null) push(childrenOf, meta.parent, t);
    for (const b of meta.blockedBy) push(blocksOf, b, t);
    for (const l of meta.labels) labels.add(l);
    if (meta.cycle !== null) cycles.set(meta.cycle.id, meta.cycle);
  }
  const index: TaskIndex = {
    byId,
    parentIds: new Set(childrenOf.keys()),
    childrenOf,
    blocksOf,
    labels: [...labels].sort(),
    cycles: [...cycles.values()].sort((a, b) => a.number - b.number),
  };
  cache.set(tasks, index);
  return index;
}

/** A task's direct children in list order, from the shared index. */
export function childrenIn(
  index: TaskIndex,
  id: string
): readonly TaskListItem[] {
  return index.childrenOf.get(id) ?? EMPTY;
}

/** The tasks that name `id` as a blocker, from the shared index. */
export function blocksIn(
  index: TaskIndex,
  id: string
): readonly TaskListItem[] {
  return index.blocksOf.get(id) ?? EMPTY;
}
