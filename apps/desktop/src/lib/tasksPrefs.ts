import type { TaskListItem } from '@dispatch-foo/core/browser';

import { TASKS_VIEW_TABS, type TasksViewMode } from './tasksViewMode';

/**
 * The Tasks page's persisted preferences: the status/priority filter chips and the one
 * display model the list, board, milestones and branches layouts share (Linear's Display
 * popover — grouping, ordering, sub-task handling, which properties a row shows). Everything
 * is parsed defensively from localStorage — a bad or stale payload falls back to defaults
 * rather than throwing during render.
 */

export interface TaskFilters {
  /** Statuses the chip row has active — empty means "no filter", everything passes. */
  statuses: string[];
  /** Priorities the chip row has active — same empty-means-all semantics. */
  priorities: string[];
}

/** The header's view tabs are the layouts: `BoardView` writes the view mode straight into
 * `layout`, and a saved view feeds `layout` back as the mode, so the two stay one type. */
type TasksLayout = TasksViewMode;
export type TasksGrouping =
  | 'status'
  | 'epic'
  | 'milestone'
  | 'assignee'
  | 'priority'
  | 'none';
export type TasksSubGrouping = 'none' | 'epic' | 'assignee' | 'priority';
export type TasksOrdering =
  | 'priority'
  | 'updated'
  | 'created'
  | 'title'
  | 'manual';
type TasksOrderDir = 'asc' | 'desc';
/** The row/card properties the Display popover's toggle-chips switch on and off. */
export type TaskProperty =
  | 'id'
  | 'status'
  | 'assignee'
  | 'priority'
  | 'epic'
  | 'milestone'
  | 'labels'
  | 'links'
  | 'created'
  | 'updated'
  | 'run';
type TaskDateField = 'created' | 'updated';

export interface TasksDisplayPrefs {
  layout: TasksLayout;
  grouping: TasksGrouping;
  subGrouping: TasksSubGrouping;
  ordering: TasksOrdering;
  /** `asc` is each ordering's natural direction — urgent first, newest first, A→Z. */
  orderDir: TasksOrderDir;
  /** Landed/dropped rows sink to the bottom of their group, most recently updated first. */
  completedByRecency: boolean;
  /** Off hides every task that has a parent. */
  showSubtasks: boolean;
  /** Sub-tasks indent under their parent's row when both land in the same group. */
  nestedSubtasks: boolean;
  /** Render a status/priority/epic group even when nothing is in it. */
  showEmptyGroups: boolean;
  properties: ReadonlySet<TaskProperty>;
  /** Which date the row's far-right `Sep 13` shows. */
  dateField: TaskDateField;
}

export const TASK_FILTERS_STORAGE_KEY = 'dispatch:tasks-filters-v1';
export const TASKS_DISPLAY_STORAGE_KEY = 'dispatch:tasks-display-v1';
/** Stamped into every serialised display model. Payloads without it (or below it) were
 * written before board lanes moved to `subGrouping` and go through that migration once. */
const TASKS_DISPLAY_VERSION = 2;

export const EMPTY_TASK_FILTERS: TaskFilters = { statuses: [], priorities: [] };

const LAYOUTS: readonly TasksLayout[] = TASKS_VIEW_TABS.map((t) => t.id);
const GROUPINGS: readonly TasksGrouping[] = [
  'status',
  'epic',
  'milestone',
  'assignee',
  'priority',
  'none',
];
const SUB_GROUPINGS: readonly TasksSubGrouping[] = [
  'none',
  'epic',
  'assignee',
  'priority',
];
const ORDERINGS: readonly TasksOrdering[] = [
  'priority',
  'updated',
  'created',
  'title',
  'manual',
];
const ORDER_DIRS: readonly TasksOrderDir[] = ['asc', 'desc'];
const DATE_FIELDS: readonly TaskDateField[] = ['created', 'updated'];
export const TASK_PROPERTIES: readonly TaskProperty[] = [
  'id',
  'status',
  'assignee',
  'priority',
  'epic',
  'milestone',
  'labels',
  'links',
  'created',
  'updated',
  'run',
];

export const DEFAULT_TASKS_DISPLAY: TasksDisplayPrefs = {
  layout: 'board',
  grouping: 'status',
  subGrouping: 'none',
  ordering: 'priority',
  orderDir: 'asc',
  completedByRecency: true,
  showSubtasks: true,
  nestedSubtasks: true,
  showEmptyGroups: false,
  properties: new Set<TaskProperty>([
    'id',
    'status',
    'assignee',
    'priority',
    'epic',
    'labels',
    'run',
    'updated',
  ]),
  dateField: 'updated',
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

// Picks `value` when it is one of `allowed`, else the default — every enum field parses
// through this so a renamed or removed option degrades to the default instead of leaking an
// unknown string into a `switch`.
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parseTaskFilters(stored: string | null): TaskFilters {
  if (stored === null) return EMPTY_TASK_FILTERS;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) {
      return EMPTY_TASK_FILTERS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      statuses: stringArray(record.statuses),
      priorities: stringArray(record.priorities),
    };
  } catch {
    return EMPTY_TASK_FILTERS;
  }
}

/** The field-by-field walk behind `parseTasksDisplay`, exposed so a display model nested
 * inside another payload (a saved view) parses the same way. A payload written by an older
 * build (or the retired `dispatch:board-columns-v1` / `dispatch:list-hidden-columns-v1`
 * shapes, which share none of these keys) lands on the defaults for whatever it does not
 * carry. `null` for anything that is not a plain object. */
export function tasksDisplayFromValue(
  value: unknown
): TasksDisplayPrefs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const d = DEFAULT_TASKS_DISPLAY;
  const properties = Array.isArray(record.properties)
    ? new Set(
        record.properties.filter((p): p is TaskProperty =>
          (TASK_PROPERTIES as readonly unknown[]).includes(p)
        )
      )
    : d.properties;
  const layout = oneOf(record.layout, LAYOUTS, d.layout);
  const grouping = oneOf(record.grouping, GROUPINGS, d.grouping);
  let subGrouping = oneOf(record.subGrouping, SUB_GROUPINGS, d.subGrouping);
  // Board lanes moved from `grouping` to `subGrouping`: a board stored as grouped by epic
  // with no sub-grouping of its own keeps its epic lanes. `grouping` stays as stored — the
  // list still groups by it. Only unstamped payloads migrate; a stamped one wrote
  // `subGrouping: 'none'` deliberately (the board's Ungroup) and must stay that way.
  const stamped =
    typeof record.version === 'number' &&
    record.version >= TASKS_DISPLAY_VERSION;
  if (
    !stamped &&
    layout === 'board' &&
    grouping === 'epic' &&
    subGrouping === 'none'
  ) {
    subGrouping = 'epic';
  }
  return {
    layout,
    grouping,
    subGrouping,
    ordering: oneOf(record.ordering, ORDERINGS, d.ordering),
    orderDir: oneOf(record.orderDir, ORDER_DIRS, d.orderDir),
    completedByRecency: bool(record.completedByRecency, d.completedByRecency),
    showSubtasks: bool(record.showSubtasks, d.showSubtasks),
    nestedSubtasks: bool(record.nestedSubtasks, d.nestedSubtasks),
    showEmptyGroups: bool(record.showEmptyGroups, d.showEmptyGroups),
    properties,
    dateField: oneOf(record.dateField, DATE_FIELDS, d.dateField),
  };
}

/** Reads the display model back from storage; bad JSON or a non-object payload is the
 * defaults. */
export function parseTasksDisplay(stored: string | null): TasksDisplayPrefs {
  if (stored === null) return DEFAULT_TASKS_DISPLAY;
  try {
    return tasksDisplayFromValue(JSON.parse(stored)) ?? DEFAULT_TASKS_DISPLAY;
  } catch {
    return DEFAULT_TASKS_DISPLAY;
  }
}

/** The storage payload. Field order is fixed here and `properties` is written as a sorted
 * array, so two equal models always serialize to the same string whatever order their
 * fields were assigned in — `savedViews.ts` compares these strings. The `version` stamp
 * marks the payload as post-migration (see `tasksDisplayFromValue`). */
export function serializeTasksDisplay(prefs: TasksDisplayPrefs): string {
  return JSON.stringify({
    version: TASKS_DISPLAY_VERSION,
    layout: prefs.layout,
    grouping: prefs.grouping,
    subGrouping: prefs.subGrouping,
    ordering: prefs.ordering,
    orderDir: prefs.orderDir,
    completedByRecency: prefs.completedByRecency,
    showSubtasks: prefs.showSubtasks,
    nestedSubtasks: prefs.nestedSubtasks,
    showEmptyGroups: prefs.showEmptyGroups,
    properties: [...prefs.properties].sort(),
    dateField: prefs.dateField,
  });
}

/** Flips one display property — the Display popover's toggle-chip. Returns a new prefs
 * object with a new set; never mutates. */
export function toggleDisplayProperty(
  prefs: TasksDisplayPrefs,
  property: TaskProperty
): TasksDisplayPrefs {
  const properties = new Set(prefs.properties);
  if (!properties.delete(property)) properties.add(property);
  return { ...prefs, properties };
}

/** Toggles one value in a filter array — the chip row's onToggle. */
export function toggleFilterValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}

export function hasActiveFilters(filters: TaskFilters): boolean {
  return filters.statuses.length > 0 || filters.priorities.length > 0;
}

/** Whether one task passes the chip filters. Empty filter arrays pass everything; active
 * statuses/priorities each union within their group and intersect across groups. */
export function matchesTaskFilters(
  doc: TaskListItem,
  filters: TaskFilters
): boolean {
  if (
    filters.statuses.length > 0 &&
    !filters.statuses.includes(doc.meta.status)
  ) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(doc.meta.priority)
  ) {
    return false;
  }
  return true;
}
