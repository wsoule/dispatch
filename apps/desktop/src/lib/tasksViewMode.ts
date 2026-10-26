/**
 * Which layout the Tasks view opens in.
 *
 * `board` is the unified kanban and the default: every epic is an expandable header row with the
 * project's configured status columns under it, so there is no longer a separate `lanes` mode —
 * the flat status-only board and the epic swim lanes were the same board grouped two ways, and
 * one layout that collapses does both jobs. `list` is the dense grouped list. The former
 * `milestones` layout (the milestone map, later the Graph mode) is a page of its own now
 * (`HostedView` 'graph' in lib/appNav.ts), not a layout of the list.
 */
export type TasksViewMode = 'board' | 'list';

/** The page header's view tabs (`Board` `List`), in the order they render; the
 * Display popover's segmented control lists the same two. */
export const TASKS_VIEW_TABS: readonly { id: TasksViewMode; label: string }[] =
  [
    { id: 'board', label: 'Board' },
    { id: 'list', label: 'List' },
  ];

/**
 * A NEW storage key, not the original `dispatch:tasks-view-mode`.
 *
 * The original is untrustworthy and cannot be migrated from. BoardView persists the current mode
 * on every mount, so it wrote the then-default `'board'` for everyone who ever opened the view —
 * whether they chose it or not. Reading that key back would pin every existing user to the old
 * layout permanently, while looking in the code exactly like honouring a preference. There is no
 * way to tell a real choice from an auto-saved default in that key, so it is abandoned.
 */
export const VIEW_MODE_STORAGE_KEY = 'dispatch:tasks-view-mode-v2';

/** A stored `'lanes'` (this key's own former default) is not special-cased: swim lanes and the
 * flat board merged into `board`, so it falls through to the default and lands there anyway. */
export function parseViewMode(stored: string | null): TasksViewMode {
  if (stored === 'list' || stored === 'board') return stored;
  // The retired layouts drew the same tasks grouped by milestone: Branches as a
  // graph, Milestones as the map, Graph as the chart. The graph is a page of its
  // own now, so a window that last chose one of them opens on the list, the
  // layout that still groups by milestone.
  if (isRetiredLayout(stored)) return 'list';
  return 'board';
}

/** The layout ids a stored payload may still carry for the retired milestone
 * layouts, every one of which reads as the list. */
export function isRetiredLayout(stored: unknown): boolean {
  return stored === 'branches' || stored === 'milestones' || stored === 'graph';
}
