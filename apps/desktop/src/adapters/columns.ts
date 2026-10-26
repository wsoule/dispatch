import type { TaskColumnId } from '@dispatch/ui';

import {
  DEFAULT_TASKS_DISPLAY,
  type TaskProperty,
  type TasksDisplayPrefs,
  type TasksGrouping,
} from '../lib/tasksPrefs';

// The Display popover's property set → @dispatch/ui's TaskGroupTable columns.
// The popover keeps Dispatch's own vocabulary (status, epic, labels, run, the
// two dates); the table has six meta columns of its own, so this is the one
// place that says which toggle shows which column. Pure data, unit-tested
// without React.

/**
 * Header wording where Dispatch's copy differs from the table's defaults
 * ("Issue / Project / State / Priority / Due"): Dispatch calls a task's
 * workflow position its *status* everywhere else (the Display popover's
 * property, the filter facet, the `s` key's picker, the status strip), so the
 * column header says "Status" too. The other headers keep the library's words.
 */
export const COLUMN_LABELS: Readonly<
  Partial<Record<TaskColumnId | 'title', string>>
> = { state: 'Status' };

/** The table's meta columns in the order Dispatch draws them: the hierarchy
 * first (where the task sits), then its workflow facts, then who and when. */
const COLUMN_ORDER: readonly TaskColumnId[] = [
  'project',
  'milestone',
  'state',
  'priority',
  'assignee',
  'due',
];

/** A grouping whose header already names the task's container, so the
 * hierarchy columns would repeat it on every row. */
function groupsByContainer(grouping: TasksGrouping): boolean {
  return grouping === 'epic' || grouping === 'milestone';
}

/**
 * Which table columns the Display popover's properties switch on, under a
 * grouping:
 *
 * - `project` and `milestone` (the nearest project and milestone containers,
 *   the successors of the old row's ` › epic` chip) when the Epic or the
 *   Milestone property is on — Dispatch's two toggles both mean "show where
 *   the task sits" — unless the grouping is by epic or milestone, whose group
 *   headers already name the container;
 * - `state` for Status, `priority` for Priority and `assignee` for Assignee,
 *   each following its own toggle alone (kept even when grouped by that
 *   property, as the old row kept its glyphs, because the cell is also the
 *   inline picker's trigger);
 * - `due` when either date property (Created, Updated) is on: the person wants
 *   dates on rows, and the table's one date cell is the task's due date.
 *
 * The id and title column is always there, so the `id` property has no column
 * (the key cell shows the Linear identifier or the task id), and `labels`,
 * `links` and `run` ride on the row as chips rather than columns.
 */
export function columnsForPrefs(
  prefs: TasksDisplayPrefs,
  grouping: TasksGrouping = prefs.grouping
): TaskColumnId[] {
  const has = (property: TaskProperty) => prefs.properties.has(property);
  const hierarchy =
    !groupsByContainer(grouping) && (has('epic') || has('milestone'));
  const shown: Record<TaskColumnId, boolean> = {
    project: hierarchy,
    milestone: hierarchy,
    state: has('status'),
    priority: has('priority'),
    assignee: has('assignee'),
    due: has('created') || has('updated'),
  };
  return COLUMN_ORDER.filter((column) => shown[column]);
}

/** The columns of the default display model (grouped by status, the default
 * property set): project, milestone, state, priority, assignee, due. */
export const DEFAULT_COLUMNS: readonly TaskColumnId[] = columnsForPrefs(
  DEFAULT_TASKS_DISPLAY
);
