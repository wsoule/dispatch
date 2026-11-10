import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isContainerKind } from '@dispatch-foo/core/browser';
import { NO_INITIATIVE_ID } from '@dispatch/planning';

import type { ListGroup } from './listGrouping';

/** A level the chart draws as container cards above milestones. */
export type UpperLevel = 'initiative' | 'project';

/** "No initiative": the projects in no initiative, a box (and a scope) of its own. */
const NO_INITIATIVE_LABEL = 'No initiative';

/**
 * Walks up a task's parents to its nearest ancestor of `kind` (the task itself never
 * counts); null when there is none or the chain loops.
 */
function ancestorOf(
  task: TaskListItem,
  kind: string,
  byId: ReadonlyMap<string, TaskListItem>
): TaskListItem | null {
  const seen = new Set<string>([task.meta.id]);
  for (let id = task.meta.parent; id !== null; ) {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = byId.get(id);
    if (node === undefined) return null;
    if (node.meta.kind === kind) return node;
    id = node.meta.parent;
  }
  return null;
}

/**
 * Each task's home at an upper level: its project, or its project's initiative
 * (NO_INITIATIVE_ID for a project in none). A task with no project has no home there.
 */
function upperLevelHome(
  task: TaskListItem,
  level: UpperLevel,
  byId: ReadonlyMap<string, TaskListItem>
): string | null {
  const project = ancestorOf(task, 'project', byId);
  if (project === null) return null;
  if (level === 'project') return project.meta.id;
  return ancestorOf(project, 'initiative', byId)?.meta.id ?? NO_INITIATIVE_ID;
}

/**
 * The Graph's initiative or project level as list groups, one per container in the
 * containers' own order (then "No initiative"), each holding the tasks under it. The
 * milestone map draws them as cards with the task waits between them counted, as it does
 * milestones. Tasks with no home at the level are left out, and so is a container with
 * no task under it.
 */
export function upperLevelGroups(
  tasks: readonly TaskListItem[],
  containers: readonly TaskListItem[],
  level: UpperLevel
): ListGroup[] {
  const byId = new Map<string, TaskListItem>();
  for (const doc of containers) byId.set(doc.meta.id, doc);
  for (const doc of tasks)
    if (!byId.has(doc.meta.id)) byId.set(doc.meta.id, doc);
  const rowsOf = new Map<string, TaskListItem[]>();
  for (const doc of tasks) {
    if (isContainerKind(doc.meta.kind)) continue;
    const home = upperLevelHome(doc, level, byId);
    if (home === null) continue;
    const rows = rowsOf.get(home);
    if (rows === undefined) rowsOf.set(home, [doc]);
    else rows.push(doc);
  }
  const order = containers
    .filter((doc) => doc.meta.kind === level)
    .map((doc) => doc.meta.id);
  if (level === 'initiative') order.push(NO_INITIATIVE_ID);
  return order.flatMap((id) => {
    const rows = rowsOf.get(id);
    if (rows === undefined) return [];
    return [
      {
        key: `${level}:${id}`,
        kind: 'milestone' as const,
        label:
          id === NO_INITIATIVE_ID
            ? NO_INITIATIVE_LABEL
            : (byId.get(id)?.meta.title ?? id),
        icon: null,
        rows: rows.map((doc) => ({ doc, indent: 0 as const })),
        preset: {},
        milestoneId: id,
        archived: false,
      },
    ];
  });
}

/**
 * The frame each card of a level sits in, for "Box by …": a milestone's project, a
 * project's initiative. Cards with no such parent are left out (they sit unframed).
 */
export function cardParents(
  groups: readonly ListGroup[],
  containers: readonly TaskListItem[],
  parentKind: UpperLevel
): Map<string, { id: string; label: string }> {
  const byId = new Map(containers.map((doc) => [doc.meta.id, doc]));
  const out = new Map<string, { id: string; label: string }>();
  for (const group of groups) {
    const id = group.milestoneId;
    const card = id === null ? undefined : byId.get(id);
    if (id === null || card === undefined) continue;
    const parent =
      card.meta.kind === parentKind ? null : ancestorOf(card, parentKind, byId);
    if (parent !== null) {
      out.set(id, { id: parent.meta.id, label: parent.meta.title });
    } else if (parentKind === 'initiative' && card.meta.kind === 'project') {
      out.set(id, { id: NO_INITIATIVE_ID, label: NO_INITIATIVE_LABEL });
    }
  }
  return out;
}
