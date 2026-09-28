import type { StatusModel, TaskListItem } from '@dispatch/core/browser';
import {
  canonicalKind,
  isCanceledStatus,
  isCompletedStatus,
  isContainerKind,
  isDoneStatus,
  isStartedStatus,
  PRIORITY_ORDER,
} from '@dispatch/core/browser';

import { activeStatusModel } from './statusModel';

/**
 * The Projects page's model: Linear's hierarchy as one tree — initiatives, their projects,
 * those projects' milestones, then the issues (and sub-issues) under each. Pure and
 * DOM-free: `buildProjectTree` indexes the tasks once (O(n)), `flattenProjectTree` turns
 * the expanded part into the flat rows the virtual list draws.
 */

const KIND_RANK: Record<string, number> = {
  initiative: 0,
  project: 1,
  milestone: 2,
  task: 3,
};

/** Done/total over a container's issues by status type — canceled ones count in neither,
 * the way Linear's project progress reads. */
export interface TreeRollup {
  done: number;
  total: number;
  started: number;
  /** Open issues whose latest run is waiting on a human or failed. */
  attention: number;
}

export type ContainerHealth = 'done' | 'off-track' | 'at-risk' | 'on-track';

export interface ProjectTree {
  /** Top-level containers: initiatives, then projects and milestones with no parent. */
  roots: readonly string[];
  /** Each node's children, containers first. Only ids with children appear. */
  children: ReadonlyMap<string, readonly string[]>;
  byId: ReadonlyMap<string, TaskListItem>;
  /** Every node that has children (containers and parent issues). */
  rollups: ReadonlyMap<string, TreeRollup>;
}

const EMPTY_ROLLUP: TreeRollup = {
  done: 0,
  total: 0,
  started: 0,
  attention: 0,
};

// Containers by kind, milestones by target date (undated last); issues open first, then
// by priority. Stable, so equal keys keep the tracker's order.
function childOrder(
  a: TaskListItem,
  b: TaskListItem,
  index: ReadonlyMap<string, number>,
  model: StatusModel
): number {
  const ka = KIND_RANK[canonicalKind(a.meta.kind)] ?? 3;
  const kb = KIND_RANK[canonicalKind(b.meta.kind)] ?? 3;
  if (ka !== kb) return ka - kb;
  if (ka === KIND_RANK.milestone) {
    const da = a.meta.dueDate ?? '9999';
    const db = b.meta.dueDate ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
  } else if (ka === KIND_RANK.task) {
    const doneA = isDoneStatus(a.meta.status, model) ? 1 : 0;
    const doneB = isDoneStatus(b.meta.status, model) ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const pa = PRIORITY_ORDER[a.meta.priority];
    const pb = PRIORITY_ORDER[b.meta.priority];
    if (pa !== pb) return pa - pb;
  }
  return (index.get(a.meta.id) ?? 0) - (index.get(b.meta.id) ?? 0);
}

/**
 * Indexes `tasks` into the hierarchy. A project listed under several initiatives appears
 * under each (its first is `parent`, the rest `initiatives`). Issues outside every
 * container are not part of the tree. `attention` names the tasks whose run needs a human;
 * `model` is the project's statuses, which a memo keyed on config passes from that config.
 */
export function buildProjectTree(
  tasks: readonly TaskListItem[],
  attention: ReadonlySet<string> = new Set(),
  model: StatusModel = activeStatusModel()
): ProjectTree {
  const byId = new Map<string, TaskListItem>();
  const index = new Map<string, number>();
  tasks.forEach((doc, i) => {
    byId.set(doc.meta.id, doc);
    index.set(doc.meta.id, i);
  });
  const lists = new Map<string, TaskListItem[]>();
  const linked = new Set<string>();
  const link = (parentId: string, doc: TaskListItem) => {
    const edge = `${parentId}>${doc.meta.id}`;
    if (linked.has(edge)) return;
    linked.add(edge);
    const list = lists.get(parentId);
    if (list === undefined) lists.set(parentId, [doc]);
    else list.push(doc);
  };
  const roots: TaskListItem[] = [];
  for (const doc of tasks) {
    const parent = doc.meta.parent;
    const hasParent =
      parent !== null && parent !== doc.meta.id && byId.has(parent);
    if (hasParent) link(parent, doc);
    for (const initiative of doc.meta.initiatives ?? []) {
      if (initiative !== parent && byId.has(initiative)) link(initiative, doc);
    }
    if (!hasParent && isContainerKind(doc.meta.kind)) roots.push(doc);
  }
  const compare = (a: TaskListItem, b: TaskListItem) =>
    childOrder(a, b, index, model);
  const children = new Map<string, readonly string[]>();
  for (const [id, list] of lists) {
    children.set(
      id,
      list.sort(compare).map((doc) => doc.meta.id)
    );
  }

  // Bottom-up counts, memoized per id; a cycle contributes nothing past its first visit.
  const rollups = new Map<string, TreeRollup>();
  const visiting = new Set<string>();
  const rollupOf = (id: string): TreeRollup => {
    const cached = rollups.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return EMPTY_ROLLUP;
    visiting.add(id);
    const sum = { done: 0, total: 0, started: 0, attention: 0 };
    for (const childId of children.get(id) ?? []) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      if (!isContainerKind(child.meta.kind)) {
        countIssue(sum, child, attention, model);
      }
      const below = children.has(childId) ? rollupOf(childId) : EMPTY_ROLLUP;
      sum.done += below.done;
      sum.total += below.total;
      sum.started += below.started;
      sum.attention += below.attention;
    }
    visiting.delete(id);
    rollups.set(id, sum);
    return sum;
  };
  for (const id of children.keys()) rollupOf(id);

  return {
    roots: roots.sort(compare).map((doc) => doc.meta.id),
    children,
    byId,
    rollups,
  };
}

function countIssue(
  sum: TreeRollup,
  doc: TaskListItem,
  attention: ReadonlySet<string>,
  model: StatusModel
): void {
  const { status } = doc.meta;
  if (isCanceledStatus(status, model)) return;
  sum.total += 1;
  if (isCompletedStatus(status, model)) {
    sum.done += 1;
    return;
  }
  // A closed issue's failed or unreviewed run is history, not a risk.
  if (attention.has(doc.meta.id)) sum.attention += 1;
  if (isStartedStatus(status, model)) sum.started += 1;
}

/**
 * How a container is doing: every issue closed is done; past its target date with open
 * work is off track; an issue waiting on a human or failed puts it at risk; otherwise,
 * once anything moved, on track. Null before anything has started.
 */
export function containerHealth(
  doc: TaskListItem,
  rollup: TreeRollup,
  today: string
): ContainerHealth | null {
  if (rollup.total > 0 && rollup.done === rollup.total) return 'done';
  const due = doc.meta.dueDate;
  if (due !== null && due !== undefined && due.slice(0, 10) < today) {
    return 'off-track';
  }
  if (rollup.attention > 0) return 'at-risk';
  if (rollup.started > 0 || rollup.done > 0) return 'on-track';
  return null;
}

/** One drawn row: a node at its place in the tree. `key` is its path, so a project under
 * two initiatives is two rows. */
export interface TreeRow {
  key: string;
  id: string;
  depth: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** The key a node has under `parentKey` — a path, never just the id. */
function treeRowKey(parentKey: string | null, id: string): string {
  return parentKey === null ? id : `${parentKey}/${id}`;
}

/**
 * The rows to draw: depth-first through the tree, descending only into expanded nodes.
 * `isExpanded` gets each expandable row's key and kind. Cycles stop at their first repeat.
 */
export function flattenProjectTree(
  tree: ProjectTree,
  isExpanded: (key: string, doc: TaskListItem) => boolean
): TreeRow[] {
  const rows: TreeRow[] = [];
  const onPath = new Set<string>();
  const visit = (id: string, parentKey: string | null, depth: number) => {
    const doc = tree.byId.get(id);
    if (doc === undefined || onPath.has(id)) return;
    const key = treeRowKey(parentKey, id);
    const kids = tree.children.get(id);
    const expandable = kids !== undefined && kids.length > 0;
    const expanded = expandable && isExpanded(key, doc);
    rows.push({ key, id, depth, parentKey, expandable, expanded });
    if (!expanded) return;
    onPath.add(id);
    for (const child of kids) visit(child, key, depth + 1);
    onPath.delete(id);
  };
  for (const root of tree.roots) visit(root, null, 0);
  return rows;
}

/** Where a node starts: initiatives and projects open, milestones and parent issues
 * folded, so the first screen is the plan rather than two thousand issues. */
export function expandedByDefault(doc: TaskListItem): boolean {
  const kind = canonicalKind(doc.meta.kind);
  return kind === 'initiative' || kind === 'project';
}
