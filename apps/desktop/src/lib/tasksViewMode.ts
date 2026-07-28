/**
 * Which layout the Tasks view opens in.
 *
 * `lanes` is the board: one swim lane per epic, with the project's configured status columns
 * inside each. It is the default because that is how the work is organised here. `board` is the
 * older flat single-set-of-columns layout, kept for anyone who prefers it. `list` is the dense
 * grouped list.
 */
export type TasksViewMode = 'board' | 'lanes' | 'list' | 'milestones';

/**
 * A NEW storage key, not the original `dispatch:tasks-view-mode`.
 *
 * The original is untrustworthy and cannot be migrated from. BoardView persists the current mode
 * on every mount, so it wrote the then-default `'board'` for everyone who ever opened the view —
 * whether they chose it or not. Reading that back would pin every existing user to the old
 * layout permanently, while looking in the code exactly like honouring a preference. There is no
 * way to tell a real choice from an auto-saved default in that key, so it is abandoned.
 */
export const VIEW_MODE_STORAGE_KEY = 'dispatch:tasks-view-mode-v2';

export function parseViewMode(stored: string | null): TasksViewMode {
  if (
    stored === 'list' ||
    stored === 'board' ||
    stored === 'lanes' ||
    stored === 'milestones'
  ) {
    return stored;
  }
  return 'lanes';
}
