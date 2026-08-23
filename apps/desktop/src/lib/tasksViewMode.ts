import { useCallback, useState } from 'react';

/**
 * Which layout the Tasks view opens in.
 *
 * `board` is the unified kanban and the default: every epic is an expandable header row with the
 * project's configured status columns under it, so there is no longer a separate `lanes` mode —
 * the flat status-only board and the epic swim lanes were the same board grouped two ways, and
 * one layout that collapses does both jobs. `list` is the dense grouped list; `milestones` groups
 * the same tasks by milestone.
 */
export type TasksViewMode = 'board' | 'list' | 'milestones';

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
  if (stored === 'list' || stored === 'board' || stored === 'milestones') {
    return stored;
  }
  return 'board';
}

/**
 * The Tasks view mode as App-level state: read once from storage, written only on an
 * explicit change — never on mount, which is exactly the auto-save-the-default flaw that
 * poisoned the v1 key (see `VIEW_MODE_STORAGE_KEY`).
 */
export function useTasksViewMode(): [
  TasksViewMode,
  (mode: TasksViewMode) => void,
] {
  const [mode, setMode] = useState<TasksViewMode>(() =>
    parseViewMode(
      typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    )
  );
  const set = useCallback((next: TasksViewMode) => {
    setMode(next);
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
  }, []);
  return [mode, set];
}
