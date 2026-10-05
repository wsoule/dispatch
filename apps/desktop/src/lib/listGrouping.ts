import type {
  Assignee,
  Priority,
  StatusModel,
  TaskListItem,
} from '@dispatch/core/browser';
import {
  canonicalKind,
  isContainerKind,
  isDoneStatus,
  PRIORITY_ORDER,
} from '@dispatch/core/browser';

import { statusColor } from '../components/tasks/StatusIcon';
import { isMilestoneFinished, rollupMilestoneStatus } from './milestoneRollup';
import { colorForEpic } from './projectColor';
import { activeStatusModel } from './statusModel';
import {
  assigneeLabel,
  assigneeRef,
  priorityLabel,
  statusLabel,
} from './taskDisplay';
import type { TasksDisplayPrefs, TasksGrouping } from './tasksPrefs';

/**
 * The list's grouping model: `groupTasks` turns the visible tasks plus the display prefs into
 * the ordered sections the list (and the Milestones page) render — one `GroupHeader` per
 * group over a run of `ListRow`s. Every grouping (status, epic, milestone, assignee,
 * priority, none) comes out in the same shape so the view has one rendering path, and the
 * ordering / completed-by-recency / nested-sub-task rules apply identically to all of them.
 */

/** What the group's 14px glyph is — the view maps this to a `StatusIcon`, an epic swatch, a
 * milestone target, an avatar or a priority glyph. */
export type GroupIcon =
  | { kind: 'status'; status: string }
  | { kind: 'epic'; epicId: string | null }
  | { kind: 'milestone'; status: string }
  | { kind: 'assignee'; assignee: Assignee }
  | { kind: 'priority'; priority: Priority }
  | null;

export interface ListGroupRow {
  doc: TaskListItem;
  /** `1` nests the row under its parent, which is the row directly above it (or above its
   * indented siblings). */
  indent: 0 | 1;
}

export interface ListGroup {
  /** Stable across renders and groupings — `status:ready`, `epic:e-1`, `epic:none`,
   * `assignee:agent`, `priority:high`, `all`, `archived`. Collapse state is keyed by it. */
  key: string;
  kind: TasksGrouping | 'archived';
  label: string;
  /** The status colour the header's left edge picks up, or none for a neutral bar. */
  tint: string | null;
  icon: GroupIcon;
  rows: ListGroupRow[];
  /** What a `+` on this header pre-fills into the task creator: a status, or the
   * container (`epic`) the new task goes under as its parent. */
  preset: { status?: string; epic?: string };
  /** The epic this group stands for, when it stands for one — the dependency-graph button
   * and the milestone's "open" affordance key off it. */
  epicId: string | null;
  /** Rows in the trailing "Archived" section render read-only. */
  archived: boolean;
}

export interface GroupContext {
  /** The project's statuses in config order — status groups follow it. */
  statuses: readonly string[];
  /** Every container (a container kind, or a task with children) in project order —
   * epic and milestone groups follow it, and the milestone grouping walks it for the
   * hierarchy above each task. */
  epics: readonly TaskListItem[];
  /** Appended as a trailing `Archived` group when non-empty (the "Show archived" toggle). */
  archivedTasks?: readonly TaskListItem[];
  /** The project's statuses, which tint headers, roll milestones up and sink finished work.
   * A memo keyed on config passes that config's: the module-level one updates a render
   * later. */
  model?: StatusModel;
}

const NO_EPIC_KEY = 'epic:none';
const ARCHIVED_KEY = 'archived';

// Each task's parsed time per field, so a sort parses a date once per task instead of twice
// per comparison (~44k parses for 2000 tasks). Keyed by the item: a patched task is a new one.
const parsedTimes = {
  updated: new WeakMap<TaskListItem, number>(),
  created: new WeakMap<TaskListItem, number>(),
};

function byDateDesc(field: 'updated' | 'created') {
  const cache = parsedTimes[field];
  const time = (task: TaskListItem) => {
    let at = cache.get(task);
    if (at === undefined) {
      at = Date.parse(task.meta[field]);
      cache.set(task, at);
    }
    return at;
  };
  return (a: TaskListItem, b: TaskListItem) => time(b) - time(a);
}

// Each ordering's natural comparator: urgent first, newest first, A→Z. `manual` keeps the
// input order (the tracker's own file order).
function comparatorFor(
  prefs: TasksDisplayPrefs
): ((a: TaskListItem, b: TaskListItem) => number) | null {
  switch (prefs.ordering) {
    case 'priority':
      return (a, b) =>
        PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority];
    case 'updated':
      return byDateDesc('updated');
    case 'created':
      return byDateDesc('created');
    case 'title':
      return (a, b) => a.meta.title.localeCompare(b.meta.title);
    case 'manual':
      return null;
  }
}

/** Orders one group's tasks by `ordering`/`orderDir`, then — when `completedByRecency` —
 * sinks landed/dropped tasks to the bottom, most recently updated first. Stable: ties keep
 * their input order. */
export function sortTasks(
  tasks: TaskListItem[],
  prefs: TasksDisplayPrefs,
  model: StatusModel = activeStatusModel()
): TaskListItem[] {
  const compare = comparatorFor(prefs);
  const sign = prefs.orderDir === 'desc' ? -1 : 1;
  const decorated = tasks.map((doc, index) => ({ doc, index }));
  if (compare !== null) {
    decorated.sort((a, b) => {
      const cmp = compare(a.doc, b.doc) * sign;
      return cmp !== 0 ? cmp : a.index - b.index;
    });
  }
  const sorted = decorated.map((d) => d.doc);
  if (!prefs.completedByRecency) return sorted;
  // The project's own status types, so Linear's "Done"/"Canceled" sink too.
  const open = sorted.filter((doc) => !isDoneStatus(doc.meta.status, model));
  const done = sorted
    .filter((doc) => isDoneStatus(doc.meta.status, model))
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      const cmp = byDateDesc('updated')(a.doc, b.doc);
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map((d) => d.doc);
  return [...open, ...done];
}

/** Lays a sorted group out as rows: with `nestedSubtasks`, a task whose parent is also in
 * the group moves directly under that parent (children keep their sorted order, and their
 * own children follow them, depth-first); otherwise every task is a top-level row in sorted
 * order. `indent` is at most 1 — the `ListRow` API draws one tree level — so a deeper
 * descendant sits at the same indent as its parent, but never vanishes. A row whose parent
 * chain never reaches a top-level row (a cycle) falls back to the top level. */
export function nestRows(
  sorted: TaskListItem[],
  prefs: TasksDisplayPrefs
): ListGroupRow[] {
  if (!prefs.nestedSubtasks) {
    return sorted.map((doc) => ({ doc, indent: 0 }));
  }
  const present = new Set(sorted.map((doc) => doc.meta.id));
  const childrenByParent = new Map<string, TaskListItem[]>();
  const top: TaskListItem[] = [];
  for (const doc of sorted) {
    const parent = doc.meta.parent;
    if (parent !== null && present.has(parent) && parent !== doc.meta.id) {
      const bucket = childrenByParent.get(parent);
      if (bucket !== undefined) bucket.push(doc);
      else childrenByParent.set(parent, [doc]);
    } else {
      top.push(doc);
    }
  }
  const rows: ListGroupRow[] = [];
  const emitted = new Set<string>();
  const emit = (doc: TaskListItem, indent: 0 | 1) => {
    if (emitted.has(doc.meta.id)) return;
    emitted.add(doc.meta.id);
    rows.push({ doc, indent });
    for (const child of childrenByParent.get(doc.meta.id) ?? []) emit(child, 1);
  };
  for (const doc of top) emit(doc, 0);
  for (const doc of sorted) emit(doc, 0);
  return rows;
}

// A sub-task is a task whose parent is another *task* — a container's children are its
// members, not sub-tasks (Linear's project members vs sub-issues), so `showSubtasks: false`
// leaves an epic-grouped list intact. `containerIds` holds container *kinds* only: a parent
// issue has children too, but what sits under it is still a sub-issue.
function isSubtask(
  doc: TaskListItem,
  containerIds: ReadonlySet<string>
): boolean {
  return doc.meta.parent !== null && !containerIds.has(doc.meta.parent);
}

interface Bucket {
  key: string;
  label: string;
  tint: string | null;
  icon: GroupIcon;
  preset: ListGroup['preset'];
  epicId: string | null;
  tasks: TaskListItem[];
}

function bucket(
  fields: Omit<Bucket, 'tasks'>,
  tasks: TaskListItem[] = []
): Bucket {
  return { ...fields, tasks };
}

// Buckets by status in config order, with a trailing bucket per status the config does not
// list but a task still carries (a renamed status must not vanish from the list).
function byStatus(
  tasks: TaskListItem[],
  ctx: GroupContext,
  model: StatusModel
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const add = (status: string) =>
    buckets.set(
      status,
      bucket({
        key: `status:${status}`,
        label: statusLabel(status),
        tint: statusColor(status, model),
        icon: { kind: 'status', status },
        preset: { status },
        epicId: null,
      })
    );
  for (const status of ctx.statuses) add(status);
  for (const doc of tasks) {
    if (!buckets.has(doc.meta.status)) add(doc.meta.status);
    buckets.get(doc.meta.status)?.tasks.push(doc);
  }
  return [...buckets.values()];
}

// Buckets under each epic in project order, then dangling parent ids, then "No epic". Epic
// docs themselves are headers, not rows: a task sits under its direct parent.
function byEpic(tasks: TaskListItem[], ctx: GroupContext): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const epicBucket = (id: string, label: string, tint: string | null) =>
    bucket({
      key: `epic:${id}`,
      label,
      tint,
      icon: { kind: 'epic', epicId: id },
      preset: { epic: id },
      epicId: id,
    });
  for (const epic of ctx.epics) {
    buckets.set(
      epic.meta.id,
      epicBucket(epic.meta.id, epic.meta.title, colorForEpic(epic.meta.id))
    );
  }
  const noEpic: TaskListItem[] = [];
  for (const doc of tasks) {
    if (isContainerKind(doc.meta.kind)) continue;
    const parent = doc.meta.parent;
    if (parent === null) {
      noEpic.push(doc);
      continue;
    }
    let target = buckets.get(parent);
    if (target === undefined) {
      target = epicBucket(parent, parent, null);
      buckets.set(parent, target);
    }
    target.tasks.push(doc);
  }
  const result = [...buckets.values()];
  if (noEpic.length > 0) result.push(noParentBucket('No epic', noEpic));
  return result;
}

function noParentBucket(label: string, tasks: TaskListItem[]): Bucket {
  return bucket(
    {
      key: NO_EPIC_KEY,
      label,
      tint: null,
      icon: { kind: 'epic', epicId: null },
      preset: {},
      epicId: null,
    },
    tasks
  );
}

/**
 * The hierarchy the milestone grouping reads: for any parent id, the nearest milestone,
 * project or initiative at or above it (a parent issue passes through to its own parent).
 * `epics` carries the parent issues a list filter hid, so their sub-issues still reach the
 * milestone. A missing id answers itself, so its tasks keep a group of their own; a cycle
 * answers null. Memoized, so every task's walk costs O(1) amortized.
 */
function containerHomes(
  tasks: readonly TaskListItem[],
  epics: readonly TaskListItem[]
): (parentId: string) => string | null {
  const byId = new Map<string, TaskListItem>();
  for (const doc of epics) byId.set(doc.meta.id, doc);
  for (const doc of tasks)
    if (!byId.has(doc.meta.id)) byId.set(doc.meta.id, doc);
  const memo = new Map<string, string | null>();
  return (parentId) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let id: string | null = parentId;
    let home: string | null = null;
    while (id !== null) {
      const cached = memo.get(id);
      if (cached !== undefined) {
        home = cached;
        break;
      }
      if (seen.has(id)) break;
      seen.add(id);
      chain.push(id);
      const node = byId.get(id);
      if (node === undefined || isContainerKind(node.meta.kind)) {
        home = id;
        break;
      }
      id = node.meta.parent;
    }
    for (const link of chain) memo.set(link, home);
    return home;
  };
}

// Buckets each task under its nearest milestone (or project/initiative, for work filed
// straight under one), in hierarchy order — initiative, its projects, their milestones.
// A parent issue is a row with its sub-issues under it, never a group of its own.
// Headers wear the rolled-up status, finished ones sink to the end, then any dangling
// parent ids, then "No milestone".
function byMilestone(
  tasks: TaskListItem[],
  ctx: GroupContext,
  model: StatusModel
): Bucket[] {
  const containers = ctx.epics.filter((e) => isContainerKind(e.meta.kind));
  const homeOf = containerHomes(tasks, ctx.epics);
  const direct = new Map<string, TaskListItem[]>();
  const noMilestone: TaskListItem[] = [];
  for (const doc of tasks) {
    if (isContainerKind(doc.meta.kind)) continue;
    const home = doc.meta.parent === null ? null : homeOf(doc.meta.parent);
    if (home === null) {
      noMilestone.push(doc);
      continue;
    }
    const list = direct.get(home);
    if (list === undefined) direct.set(home, [doc]);
    else list.push(doc);
  }

  // The container tree, in project order under each parent.
  const known = new Map(containers.map((c) => [c.meta.id, c]));
  const childContainers = new Map<string, TaskListItem[]>();
  const roots: TaskListItem[] = [];
  const outerOf = (c: TaskListItem): TaskListItem | undefined => {
    const up = c.meta.parent === null ? null : homeOf(c.meta.parent);
    return up === null || up === c.meta.id ? undefined : known.get(up);
  };
  for (const c of containers) {
    const outer = outerOf(c);
    if (outer === undefined) {
      roots.push(c);
      continue;
    }
    const list = childContainers.get(outer.meta.id);
    if (list === undefined) childContainers.set(outer.meta.id, [c]);
    else list.push(c);
  }

  const result: Bucket[] = [];
  const visited = new Set<string>();
  const visit = (c: TaskListItem) => {
    const id = c.meta.id;
    if (visited.has(id)) return;
    visited.add(id);
    const inner = childContainers.get(id) ?? [];
    const own = direct.get(id) ?? [];
    direct.delete(id);
    // A project or initiative is a group only for work filed straight under it, or
    // when nothing nests below it; otherwise its milestones stand for it.
    if (
      canonicalKind(c.meta.kind) === 'milestone' ||
      own.length > 0 ||
      inner.length === 0
    ) {
      const outer = outerOf(c);
      result.push(
        bucket(
          {
            key: `milestone:${id}`,
            label:
              outer === undefined
                ? c.meta.title
                : `${outer.meta.title} › ${c.meta.title}`,
            tint: null,
            icon: { kind: 'milestone', status: 'draft' },
            preset: { epic: id },
            epicId: id,
          },
          own
        )
      );
    }
    for (const child of inner) visit(child);
  };
  for (const root of roots) visit(root);
  // What is left names a parent that is not here (a dangling id), or sits in a cycle.
  for (const [id, own] of direct) {
    result.push(
      bucket(
        {
          key: `milestone:${id}`,
          label: known.get(id)?.meta.title ?? id,
          tint: null,
          icon: { kind: 'milestone', status: 'draft' },
          preset: { epic: id },
          epicId: id,
        },
        own
      )
    );
  }

  for (const b of result) {
    const rollup = rollupMilestoneStatus(b.tasks, model);
    b.icon = { kind: 'milestone', status: rollup };
    b.tint = statusColor(rollup, model);
  }
  const finished = (b: Bucket) => isMilestoneFinished(b.tasks, model);
  const ordered = [
    ...result.filter((b) => !finished(b)),
    ...result.filter(finished),
  ];
  if (noMilestone.length > 0) {
    ordered.push(noParentBucket('No milestone', noMilestone));
  }
  return ordered;
}

// Agents first, then people by handle, then unassigned.
function byAssignee(tasks: TaskListItem[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const doc of tasks) {
    const assignee = doc.meta.assignee;
    let target = buckets.get(assignee);
    if (target === undefined) {
      target = bucket({
        key: `assignee:${assignee}`,
        label: assigneeLabel(assignee),
        tint: null,
        icon: { kind: 'assignee', assignee },
        preset: {},
        epicId: null,
      });
      buckets.set(assignee, target);
    }
    target.tasks.push(doc);
  }
  const rank = (a: Assignee) => {
    const ref = assigneeRef(a);
    if (ref === null) return 2;
    return ref.kind === 'agent' ? 0 : 1;
  };
  return [...buckets.values()].sort((a, b) => {
    const ra = rank(a.tasks[0]?.meta.assignee ?? 'none');
    const rb = rank(b.tasks[0]?.meta.assignee ?? 'none');
    return ra !== rb ? ra - rb : a.label.localeCompare(b.label);
  });
}

function byPriority(tasks: TaskListItem[]): Bucket[] {
  const order = Object.keys(PRIORITY_ORDER) as Priority[];
  const buckets = new Map<Priority, Bucket>(
    order.map((priority) => [
      priority,
      bucket({
        key: `priority:${priority}`,
        label: priorityLabel(priority),
        tint: null,
        icon: { kind: 'priority', priority },
        preset: {},
        epicId: null,
      }),
    ])
  );
  for (const doc of tasks) buckets.get(doc.meta.priority)?.tasks.push(doc);
  return [...buckets.values()];
}

/** The list's sections for the current display prefs. Empty groups are dropped unless
 * `showEmptyGroups`; the `none` grouping yields one headerless group keyed `all`; archived
 * tasks (when given) trail as one read-only `archived` group. */
export function groupTasks(
  tasks: TaskListItem[],
  prefs: TasksDisplayPrefs,
  ctx: GroupContext
): ListGroup[] {
  const containerIds = new Set(
    ctx.epics.filter((e) => isContainerKind(e.meta.kind)).map((e) => e.meta.id)
  );
  const visible = prefs.showSubtasks
    ? tasks
    : tasks.filter((doc) => !isSubtask(doc, containerIds));

  const model = ctx.model ?? activeStatusModel();
  let buckets: Bucket[];
  switch (prefs.grouping) {
    case 'status':
      buckets = byStatus(visible, ctx, model);
      break;
    case 'epic':
      buckets = byEpic(visible, ctx);
      break;
    case 'milestone':
      buckets = byMilestone(visible, ctx, model);
      break;
    case 'assignee':
      buckets = byAssignee(visible);
      break;
    case 'priority':
      buckets = byPriority(visible);
      break;
    case 'none':
      buckets = [
        bucket(
          {
            key: 'all',
            label: '',
            tint: null,
            icon: null,
            preset: {},
            epicId: null,
          },
          visible
        ),
      ];
      break;
  }

  const groups: ListGroup[] = buckets
    .filter((b) => prefs.showEmptyGroups || b.tasks.length > 0)
    .map((b) => ({
      key: b.key,
      kind: prefs.grouping,
      label: b.label,
      tint: b.tint,
      icon: b.icon,
      rows: nestRows(sortTasks(b.tasks, prefs, model), prefs),
      preset: b.preset,
      epicId: b.epicId,
      archived: false,
    }));

  const archived = ctx.archivedTasks ?? [];
  if (archived.length > 0) {
    groups.push({
      key: ARCHIVED_KEY,
      kind: 'archived',
      label: 'Archived',
      tint: null,
      icon: null,
      rows: nestRows(sortTasks([...archived], prefs, model), prefs),
      preset: {},
      epicId: null,
      archived: true,
    });
  }
  return groups;
}

/** Every row id in reading order, skipping collapsed groups — the j/k traversal order. */
export function visibleRowIds(
  groups: ListGroup[],
  collapsed: ReadonlySet<string>
): string[] {
  return groups.flatMap((g) =>
    collapsed.has(g.key) ? [] : g.rows.map((r) => r.doc.meta.id)
  );
}
