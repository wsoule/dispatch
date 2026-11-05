import {
  EMPTY_TASK_FILTER_SET,
  parseTaskFilterSet,
  serializeTaskFilterSet,
  type TaskFilterSet,
} from './taskFilters';
import {
  DEFAULT_TASKS_DISPLAY,
  parseTasksDisplay,
  serializeTasksDisplay,
  type TasksDisplayPrefs,
} from './tasksPrefs';

// The Issues list's remembered Display model and filter clauses. The storage
// keys keep their Two views names: they were the Two views beta's own keys (so
// the retired board's by-status default never leaked in), and renaming them
// would drop every person's remembered grouping and filters on upgrade.
const DISPLAY_KEY = 'dispatch:two-views-tasks-display-v1';
const FILTERS_KEY = 'dispatch:two-views-tasks-filters-v1';

/** The Issues list's default: one list grouped by milestone, the No milestone group included. */
export const ISSUES_DISPLAY: TasksDisplayPrefs = {
  ...DEFAULT_TASKS_DISPLAY,
  layout: 'list',
  grouping: 'milestone',
};

/** The Display model the Issues list last used, or its milestone-grouped default.
 * A model saved with the retired Graph layout reads as the list (`parseTasksDisplay`). */
export function readIssuesDisplay(): TasksDisplayPrefs {
  try {
    const raw = window.localStorage.getItem(DISPLAY_KEY);
    return raw === null ? ISSUES_DISPLAY : parseTasksDisplay(raw);
  } catch {
    return ISSUES_DISPLAY;
  }
}

export function writeIssuesDisplay(prefs: TasksDisplayPrefs): void {
  try {
    window.localStorage.setItem(DISPLAY_KEY, serializeTasksDisplay(prefs));
  } catch {
    // Kept for this session only.
  }
}

/** The filter clauses the Issues list last used, or none. */
export function readIssuesFilters(): TaskFilterSet {
  try {
    return parseTaskFilterSet(window.localStorage.getItem(FILTERS_KEY), null);
  } catch {
    return EMPTY_TASK_FILTER_SET;
  }
}

export function writeIssuesFilters(filters: TaskFilterSet): void {
  try {
    window.localStorage.setItem(FILTERS_KEY, serializeTaskFilterSet(filters));
  } catch {
    // Kept for this session only.
  }
}
