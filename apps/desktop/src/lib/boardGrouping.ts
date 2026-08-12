import type { TaskDoc } from '@dispatch/core/browser';

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

export interface BoardLane {
  /** `null` for the catch-all lane of tasks with no epic, always rendered last. */
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
  tasks: TaskDoc[],
  statuses: string[],
  epics: TaskDoc[]
): BoardLane[] {
  const byParent = new Map<string, TaskDoc[]>();
  const noEpic: TaskDoc[] = [];
  for (const task of tasks) {
    // An epic is a lane heading, not a card inside one — including it as its own child would
    // double-count it against its own progress.
    if (task.meta.kind === 'epic') continue;
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
      epicId: parentId,
      title: parentId,
      columns,
      total: countPlaced(columns),
    });
  }
  if (noEpic.length > 0) {
    const columns = groupTasksByStatus(noEpic, statuses);
    lanes.push({
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

export interface LaneStatusCount {
  /** Cards actually on screen in this status right now, across expanded lanes. */
  visible: number;
  /** Cards in this status that a collapsed lane is hiding — the "+N hidden" badge. */
  hidden: number;
}

/**
 * Per-status visible/hidden totals for the board's shared column header row.
 *
 * Collapsing an epic drops its cards out of the columns, so a header that only counted what it
 * could see would silently shrink and read as "those tasks went away". Splitting the count keeps
 * the visible number honest while still saying how much is folded up behind it.
 */
export function countLaneStatuses(
  lanes: BoardLane[],
  statuses: string[],
  collapsedLaneKeys: ReadonlySet<string>
): Map<string, LaneStatusCount> {
  const counts = new Map<string, LaneStatusCount>();
  for (const status of statuses) counts.set(status, { visible: 0, hidden: 0 });
  for (const lane of lanes) {
    const collapsed = collapsedLaneKeys.has(laneKey(lane.epicId));
    for (const column of lane.columns) {
      const entry = counts.get(column.status);
      if (entry === undefined) continue;
      if (collapsed) entry.hidden += column.tasks.length;
      else entry.visible += column.tasks.length;
    }
  }
  return counts;
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
    if (collapsedLaneKeys.has(laneKey(lane.epicId))) continue;
    for (const column of lane.columns) {
      for (const task of column.tasks) ids.push(task.meta.id);
    }
  }
  return ids;
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
