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

// Its own keys, so the retired board's by-status default never leaks in.
const DISPLAY_KEY = 'dispatch:two-views-tasks-display-v1';
const FILTERS_KEY = 'dispatch:two-views-tasks-filters-v1';

/** Two views' Tasks default: one list grouped by milestone, the No milestone group included. */
export const TWO_VIEWS_TASKS_DISPLAY: TasksDisplayPrefs = {
  ...DEFAULT_TASKS_DISPLAY,
  layout: 'list',
  grouping: 'milestone',
};

/** The Display model Two views' Tasks last used, or its milestone-grouped default.
 * A model saved with the retired Graph layout reads as the list (`parseTasksDisplay`). */
export function readTwoViewsDisplay(): TasksDisplayPrefs {
  try {
    const raw = window.localStorage.getItem(DISPLAY_KEY);
    return raw === null ? TWO_VIEWS_TASKS_DISPLAY : parseTasksDisplay(raw);
  } catch {
    return TWO_VIEWS_TASKS_DISPLAY;
  }
}

export function writeTwoViewsDisplay(prefs: TasksDisplayPrefs): void {
  try {
    window.localStorage.setItem(DISPLAY_KEY, serializeTasksDisplay(prefs));
  } catch {
    // Kept for this session only.
  }
}

/** The filter clauses Two views' Tasks last used, or none. */
export function readTwoViewsFilters(): TaskFilterSet {
  try {
    return parseTaskFilterSet(window.localStorage.getItem(FILTERS_KEY), null);
  } catch {
    return EMPTY_TASK_FILTER_SET;
  }
}

export function writeTwoViewsFilters(filters: TaskFilterSet): void {
  try {
    window.localStorage.setItem(FILTERS_KEY, serializeTaskFilterSet(filters));
  } catch {
    // Kept for this session only.
  }
}
