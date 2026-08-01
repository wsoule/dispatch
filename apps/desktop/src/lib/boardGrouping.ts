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
 * The board as epic swim lanes: one row per epic, each row a full set of status columns.
 *
 * This reads as a grid of epics against statuses rather than one tall column per status, which
 * answers a different and usually more useful question — not "what is in review" but "which epic
 * is stuck". The status columns stay exactly as they were: derived from the project's own
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
