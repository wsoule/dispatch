/**
 * The layouts the Issues list offers, as its Display popover and saved views name them.
 *
 * `board` is the unified kanban: every milestone is an expandable header row with the
 * project's configured status columns under it, so there is no separate `lanes` mode — the
 * flat status-only board and the milestone swim lanes were the same board grouped two ways,
 * and one layout that collapses does both jobs. `list` is the dense grouped list. The former
 * `milestones` layout (the milestone map, later the Graph mode) is a page of its own now
 * (`HostedView` 'graph' in lib/appNav.ts), not a layout of the list.
 *
 * Which layout shows is navigation state (`NavState.tasksMode`), carried in the hash as
 * `?mode=board` (lib/routes.ts) with `list` the default; nothing here reads or writes storage.
 */
export type TasksViewMode = 'board' | 'list';

/** The page header's view tabs (`Board` `List`), in the order they render; the
 * Display popover's segmented control lists the same two. */
export const TASKS_VIEW_TABS: readonly { id: TasksViewMode; label: string }[] =
  [
    { id: 'board', label: 'Board' },
    { id: 'list', label: 'List' },
  ];

/** The layout ids a stored payload (a saved view, the display prefs) may still carry for
 * the retired milestone layouts (Branches, Milestones, the Graph mode), every one of which
 * reads as the list, the layout that still groups by milestone. */
export function isRetiredLayout(stored: unknown): boolean {
  return stored === 'branches' || stored === 'milestones' || stored === 'graph';
}
