import type { Priority, TaskListItem } from '@dispatch/core/browser';
import { isContainerKind, PRIORITY_ORDER } from '@dispatch/core/browser';

import { assigneeLabel, assigneeRef, priorityLabel } from './taskDisplay';
import type { TasksSubGrouping } from './tasksPrefs';

export interface BoardColumnGroup {
  status: string;
  tasks: TaskListItem[];
}

/** Groups tasks into one bucket per tracker status, in the order the project's
 * `.dispatch/config.yml` lists them (never hardcoded/alphabetical) — the shape the Board
 * view renders one column per. A single pass over `tasks` with a status->bucket map, rather
 * than the old `statuses.map(status => tasks.filter(...))` (O(statuses * tasks)): every task
 * is placed in O(1) once statuses have seeded empty buckets, so this stays linear as either
 * list grows. A task whose status isn't in `statuses` is dropped from the board, matching
 * the previous filter-based behavior. */
export function groupTasksByStatus(
  tasks: TaskListItem[],
  statuses: string[]
): BoardColumnGroup[] {
  const buckets = new Map<string, TaskListItem[]>();
  for (const status of statuses) buckets.set(status, []);
  for (const task of tasks) {
    buckets.get(task.meta.status)?.push(task);
  }
  return statuses.map((status) => ({
    status,
    tasks: buckets.get(status) ?? [],
  }));
}

export interface BoardLane {
  /** What the lane is tracked by in the collapsed set — namespaced by kind (`e-…` /
   * `__no-epic__` for epic lanes, `assignee:…`, `priority:…`, `all` for the flat board) so a
   * fold on one sub-grouping never hides a lane of another. */
  key: string;
  /** Which Display › Sub-grouping produced the lane; `none` is the flat board's single lane. */
  kind: TasksSubGrouping;
  /** The raw bucket value the lane groups on — the epic id, the `meta.assignee` string or
   * the priority — so a header can render it without parsing `key`; `null` for the no-epic
   * and flat lanes. */
  value: string | null;
  /** The epic an `epic` lane belongs to, `null` for its catch-all "No epic" lane — and for
   * every lane of another kind. */
  epicId: string | null;
  title: string;
  columns: BoardColumnGroup[];
  /**
   * How many cards the lane actually renders — counted from the columns, not from the bucket.
   * A task whose status is not in the project's configured list is dropped from the board (the
   * flat board has always behaved that way), so counting the bucket would print a header
   * claiming more cards than are visible.
   */
  total: number;
}

/**
 * The board: one lane per epic, each lane a full set of status columns.
 *
 * This reads as a grid of epics against statuses rather than one tall column per status, which
 * answers a different and usually more useful question — not "what is in review" but "which epic
 * is stuck" — and collapsing the lanes (see `countLaneStatuses`) gets the status-only overview
 * back without a second layout. The status columns are derived from the project's own
 * `.dispatch/config.yml` order, never hardcoded, so drag-and-drop between them keeps working and
 * a project with custom statuses is not quietly reduced to someone else's six.
 *
 * Epics come first in the order `epics` gives (the project's own), then a lane for tasks whose
 * parent does not resolve to a known epic, then the no-epic catch-all. Empty lanes are dropped so
 * a project with twenty epics and three active ones does not render seventeen blank rows.
 */
function countPlaced(columns: BoardColumnGroup[]): number {
  return columns.reduce((n, c) => n + c.tasks.length, 0);
}

export function groupTasksByEpicLane(
  tasks: TaskListItem[],
  statuses: string[],
  epics: TaskListItem[]
): BoardLane[] {
  const byParent = new Map<string, TaskListItem[]>();
  const noEpic: TaskListItem[] = [];
  for (const task of tasks) {
    // An epic is a lane heading, not a card inside one — including it as its own child would
    // double-count it against its own progress.
    if (isContainerKind(task.meta.kind)) continue;
    const parent = task.meta.parent;
    if (parent === null) {
      noEpic.push(task);
      continue;
    }
    const bucket = byParent.get(parent);
    if (bucket === undefined) byParent.set(parent, [task]);
    else bucket.push(task);
  }

  const lanes: BoardLane[] = [];
  const seen = new Set<string>();
  for (const epic of epics) {
    const bucket = byParent.get(epic.meta.id);
    if (bucket === undefined || bucket.length === 0) continue;
    seen.add(epic.meta.id);
    const columns = groupTasksByStatus(bucket, statuses);
    lanes.push({
      key: laneKey(epic.meta.id),
      kind: 'epic',
      value: epic.meta.id,
      epicId: epic.meta.id,
      title: epic.meta.title,
      columns,
      total: countPlaced(columns),
    });
  }
  // A parent id that does not resolve to a known epic still needs somewhere honest to render,
  // rather than silently joining the no-epic lane and looking unparented.
  for (const [parentId, bucket] of byParent) {
    if (seen.has(parentId) || bucket.length === 0) continue;
    const columns = groupTasksByStatus(bucket, statuses);
    lanes.push({
      key: laneKey(parentId),
      kind: 'epic',
      value: parentId,
      epicId: parentId,
      title: parentId,
      columns,
      total: countPlaced(columns),
    });
  }
  if (noEpic.length > 0) {
    const columns = groupTasksByStatus(noEpic, statuses);
    lanes.push({
      key: laneKey(null),
      kind: 'epic',
      value: null,
      epicId: null,
      title: 'No epic',
      columns,
      total: countPlaced(columns),
    });
  }
  // Drop any lane the status filter emptied entirely, so a lane of only unconfigured-status
  // tasks does not render as a header with nothing under it.
  return lanes.filter((lane) => lane.total > 0);
}

/** The key a lane is tracked by in the collapsed-epic set: its epic id, or a reserved sentinel
 * for the catch-all "No epic" lane, which has no id of its own but still collapses. The sentinel
 * cannot collide with a real epic id — dispatch ids are `e-<hex>`. */
export function laneKey(epicId: string | null): string {
  return epicId ?? '__no-epic__';
}

// A lane of one kind over one bucket of cards; the columns are the bucket by status.
function laneOf(
  key: string,
  kind: TasksSubGrouping,
  value: string | null,
  title: string,
  bucket: TaskListItem[],
  statuses: string[]
): BoardLane {
  const columns = groupTasksByStatus(bucket, statuses);
  return {
    key,
    kind,
    value,
    epicId: null,
    title,
    columns,
    total: countPlaced(columns),
  };
}

// One lane per assignee value — agents first, then people by handle, `Unassigned` last (the
// list's assignee-group rank, re-derived here since `listGrouping`'s bucket helpers are private).
function groupTasksByAssigneeLane(
  tasks: TaskListItem[],
  statuses: string[]
): BoardLane[] {
  const buckets = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    const bucket = buckets.get(task.meta.assignee);
    if (bucket === undefined) buckets.set(task.meta.assignee, [task]);
    else bucket.push(task);
  }
  const rank = (assignee: string) => {
    const ref = assigneeRef(assignee);
    if (ref === null) return 2;
    return ref.kind === 'agent' ? 0 : 1;
  };
  const values = [...buckets.keys()].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra !== rb
      ? ra - rb
      : assigneeLabel(a).localeCompare(assigneeLabel(b));
  });
  return values.map((value) =>
    laneOf(
      `assignee:${value}`,
      'assignee',
      value,
      assigneeLabel(value),
      buckets.get(value) ?? [],
      statuses
    )
  );
}

// One lane per priority in `PRIORITY_ORDER` (urgent first, none last); empty ones dropped.
function groupTasksByPriorityLane(
  tasks: TaskListItem[],
  statuses: string[]
): BoardLane[] {
  const buckets = new Map<Priority, TaskListItem[]>();
  for (const task of tasks) {
    const bucket = buckets.get(task.meta.priority);
    if (bucket === undefined) buckets.set(task.meta.priority, [task]);
    else bucket.push(task);
  }
  return (Object.keys(PRIORITY_ORDER) as Priority[]).flatMap((priority) => {
    const bucket = buckets.get(priority);
    return bucket === undefined
      ? []
      : [
          laneOf(
            `priority:${priority}`,
            'priority',
            priority,
            priorityLabel(priority),
            bucket,
            statuses
          ),
        ];
  });
}

/**
 * The board's swim lanes for a Display › Sub-grouping: `epic` is `groupTasksByEpicLane`,
 * `assignee` and `priority` bucket on the task's own field, `none` is the one headerless lane
 * of the flat board. Whatever the kind, epics never become cards (they head epic lanes and
 * have no place in any other), every lane is the full status column set over its bucket, and
 * a lane the status filter emptied is dropped rather than drawn as a bare header.
 */
export function groupTasksByLane(
  tasks: TaskListItem[],
  statuses: string[],
  epics: TaskListItem[],
  subGrouping: TasksSubGrouping
): BoardLane[] {
  if (subGrouping === 'epic') {
    return groupTasksByEpicLane(tasks, statuses, epics);
  }
  const cards = tasks.filter((t) => !isContainerKind(t.meta.kind));
  if (subGrouping === 'none') {
    return [laneOf('all', 'none', null, '', cards, statuses)];
  }
  const lanes =
    subGrouping === 'assignee'
      ? groupTasksByAssigneeLane(cards, statuses)
      : groupTasksByPriorityLane(cards, statuses);
  return lanes.filter((lane) => lane.total > 0);
}

/**
 * Cards per status across every lane, for the board's shared column header row — the one
 * count that never moves: a collapsed epic folds its cards out of sight, not out of the
 * column, so the header keeps saying how much work is in each status.
 */
export function countLaneStatuses(
  lanes: BoardLane[],
  statuses: string[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, 0);
  for (const lane of lanes) {
    for (const column of lane.columns) {
      const current = counts.get(column.status);
      if (current === undefined) continue;
      counts.set(column.status, current + column.tasks.length);
    }
  }
  return counts;
}

/**
 * Which status columns the board renders: every configured status, minus the empty ones
 * unless the Display popover's `Show empty groups` is on, minus any the user hid for the
 * session from a column's `···` menu. Order is the config's, untouched.
 */
export function visibleBoardColumns(
  statuses: readonly string[],
  countByStatus: ReadonlyMap<string, number>,
  showEmptyGroups: boolean,
  hiddenColumns: ReadonlySet<string> = new Set()
): string[] {
  return statuses.filter(
    (status) =>
      !hiddenColumns.has(status) &&
      (showEmptyGroups || (countByStatus.get(status) ?? 0) > 0)
  );
}

/**
 * Every card the board is currently rendering, in the order the eye reads them: lane by lane,
 * and column-major within a lane (down one status column, then across to the next). This is the
 * j/k roving-focus order, so a collapsed lane contributes nothing — moving the cursor onto a card
 * that isn't on screen would scroll to nowhere and leave Enter opening an invisible task.
 */
export function visibleLaneTaskIds(
  lanes: BoardLane[],
  collapsedLaneKeys: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  for (const lane of lanes) {
    if (collapsedLaneKeys.has(lane.key)) continue;
    for (const column of lane.columns) {
      for (const task of column.tasks) ids.push(task.meta.id);
    }
  }
  return ids;
}

/**
 * The card that takes `taskId`'s place when it leaves its column (a dispatch): the one
 * below it, else the one above, else null once the column is empty. Undefined when no lane
 * holds it.
 */
export function columnSuccessor(
  lanes: readonly BoardLane[],
  taskId: string
): string | null | undefined {
  for (const lane of lanes) {
    for (const column of lane.columns) {
      const index = column.tasks.findIndex((t) => t.meta.id === taskId);
      if (index === -1) continue;
      const next = column.tasks[index + 1] ?? column.tasks[index - 1];
      return next === undefined ? null : next.meta.id;
    }
  }
  return undefined;
}

/**
 * A drop zone's @dnd-kit id, unique per lane *and* status.
 *
 * The same status column repeats once per lane, and @dnd-kit keys its droppable containers by id
 * — so if every lane's "in-review" column registered as plain `in-review`, only one of them would
 * survive as a real drop target and dragging inside any other lane would find nothing under the
 * pointer. The lane's index disambiguates them; the status is recovered from the id on drop.
 */
export function dropZoneId(laneIndex: number, status: string): string {
  return `lane:${laneIndex}:${status}`;
}

/** The status half of a `dropZoneId`, or `null` for anything that isn't one. Splits on the first
 * two colons only, so a status containing a colon still round-trips. */
export function statusFromDropZoneId(id: string): string | null {
  if (!id.startsWith('lane:')) return null;
  const statusStart = id.indexOf(':', 'lane:'.length);
  if (statusStart === -1 || statusStart === id.length - 1) return null;
  return id.slice(statusStart + 1);
}
