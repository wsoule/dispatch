// Task kinds and the container rule. Browser-safe: no node:* imports.

/** Kinds that exist to group other tasks (Linear's hierarchy above an issue). */
export const CONTAINER_KINDS = ['initiative', 'project', 'milestone'] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * A kind as stored: rows and task files written before the hierarchy say
 * `epic` for a milestone. Only storage reads call this; every input takes
 * the canonical kinds alone.
 */
export function storedKind(raw: string): string {
  return raw === 'epic' ? 'milestone' : raw;
}

/** A container by kind alone: initiative, project or milestone. */
export function isContainerKind(kind: string): boolean {
  return (CONTAINER_KINDS as readonly string[]).includes(kind);
}

/** Ids that some task in `tasks` names as its parent. */
export function parentIdsOf(
  tasks: Iterable<{ meta: { parent: string | null } }>
): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) if (t.meta.parent !== null) ids.add(t.meta.parent);
  return ids;
}

/**
 * Whether a task can fan out: a container kind, or anything with children.
 * `parentIds` is `parentIdsOf(allTasks)`; omitted, only the kind counts.
 */
export function isContainer(
  meta: { id: string; kind: string },
  parentIds?: ReadonlySet<string>
): boolean {
  return isContainerKind(meta.kind) || (parentIds?.has(meta.id) ?? false);
}

/**
 * Whether children of a parent with this kind stack on its integration
 * branch (`milestone/<id>`). Milestones and parent issues do;
 * projects and initiatives are too broad to share one branch.
 */
export function usesIntegrationBranch(parentKind: string): boolean {
  return parentKind === 'milestone' || parentKind === 'task';
}

interface HierarchyNode {
  meta: { id: string; kind: string; parent: string | null };
}

/**
 * Every task a container's fan-out covers, breadth first: its
 * non-container-kind descendants, reached only through container kinds. A
 * project's covers the issues under its milestones; a parent issue is one
 * item, and its sub-issues are its own fan-out's. Cycle-safe.
 */
export function fanoutScope<T extends HierarchyNode>(
  rootId: string,
  childrenOf: (id: string) => readonly T[]
): T[] {
  const out: T[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  // An array iterator reads the length each step, so pushed ids are visited too.
  for (const id of queue) {
    for (const child of childrenOf(id)) {
      if (seen.has(child.meta.id)) continue;
      seen.add(child.meta.id);
      if (isContainerKind(child.meta.kind)) queue.push(child.meta.id);
      else out.push(child);
    }
  }
  return out;
}

/**
 * The containers whose `fanoutScope` holds `task`, nearest first: its parent,
 * then on up through container kinds only. Empty for a container kind.
 */
export function fanoutCoverers(
  task: HierarchyNode,
  lookup: (id: string) => HierarchyNode | null | undefined
): string[] {
  if (isContainerKind(task.meta.kind)) return [];
  const out: string[] = [];
  let id = task.meta.parent;
  while (id !== null && !out.includes(id)) {
    out.push(id);
    const node = lookup(id);
    if (node === null || node === undefined) break;
    if (!isContainerKind(node.meta.kind)) break;
    id = node.meta.parent;
  }
  return out;
}

const KIND_RANK: Record<string, number> = {
  task: 0,
  milestone: 1,
  project: 2,
  initiative: 3,
};

/**
 * Whether `parentKind` may parent `childKind` in the hierarchy: a strictly
 * broader kind, or a task under a task (a sub-issue).
 */
export function isValidParentKind(
  childKind: string,
  parentKind: string
): boolean {
  const child = KIND_RANK[childKind] ?? 0;
  const parent = KIND_RANK[parentKind] ?? 0;
  return parent > child || (child === 0 && parent === 0);
}
