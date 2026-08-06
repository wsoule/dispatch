// Pure selection/focus state for the Git page's five stacked panels and the contextual right
// pane they drive. No React, no API client — BranchesView.tsx owns the actual lists.

export type GitPanelId =
  | 'status'
  | 'files'
  | 'branches'
  | 'commits'
  | 'stashes';

export const GIT_PANEL_IDS: readonly GitPanelId[] = [
  'status',
  'files',
  'branches',
  'commits',
  'stashes',
];

export interface GitPanelSelection {
  focused: GitPanelId;
  /** The selected row index within each panel's own list, kept independently so switching
   * focus away and back never loses a panel's place. `-1` means nothing selectable. */
  index: Record<GitPanelId, number>;
}

export const INITIAL_GIT_PANEL_SELECTION: GitPanelSelection = {
  focused: 'files',
  index: { status: 0, files: 0, branches: 0, commits: 0, stashes: 0 },
};

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

function withIndex(
  state: GitPanelSelection,
  panel: GitPanelId,
  index: number
): GitPanelSelection {
  if (state.index[panel] === index) return state;
  return { ...state, index: { ...state.index, [panel]: index } };
}

/** Moves focus to a panel (the `1`..`5` keys, or clicking a panel header). Leaves every
 * panel's own selected index untouched. */
export function focusGitPanel(
  state: GitPanelSelection,
  panel: GitPanelId
): GitPanelSelection {
  if (state.focused === panel) return state;
  return { ...state, focused: panel };
}

/** Moves the focused panel's selection by one row (`j`/`k`), clamped to `length` — the
 * focused panel's current list size. */
export function moveGitSelection(
  state: GitPanelSelection,
  length: number,
  delta: -1 | 1
): GitPanelSelection {
  const next = clampIndex(state.index[state.focused] + delta, length);
  return withIndex(state, state.focused, next);
}

/** Re-clamps one panel's selection against its list's current length — call after a mutation
 * or refetch changes a panel's row count, so the selection lands sensibly instead of vanishing. */
export function clampGitPanelSelection(
  state: GitPanelSelection,
  panel: GitPanelId,
  length: number
): GitPanelSelection {
  return withIndex(state, panel, clampIndex(state.index[panel], length));
}

/** Resolves what index should stay selected across a refetch: the same logical row
 * (identified by `keyOf`) if still present in `nextList`, else the old index clamped. */
export function preserveGitSelection<T>(
  prevIndex: number,
  prevList: readonly T[],
  nextList: readonly T[],
  keyOf: (item: T) => string
): number {
  const prevItem = prevList[prevIndex];
  if (prevItem !== undefined) {
    const key = keyOf(prevItem);
    const found = nextList.findIndex((item) => keyOf(item) === key);
    if (found !== -1) return found;
  }
  return clampIndex(prevIndex, nextList.length);
}

/** `preserveGitSelection` applied to one panel's slot in the full selection state. */
export function reconcileGitPanelSelection<T>(
  state: GitPanelSelection,
  panel: GitPanelId,
  prevList: readonly T[],
  nextList: readonly T[],
  keyOf: (item: T) => string
): GitPanelSelection {
  const next = preserveGitSelection(
    state.index[panel],
    prevList,
    nextList,
    keyOf
  );
  return withIndex(state, panel, next);
}

type GitFileSection = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

export interface GitFileRow {
  section: GitFileSection;
  path: string;
}

export type GitRightPane =
  | { kind: 'status' }
  | { kind: 'file'; section: GitFileSection; path: string }
  | { kind: 'branch'; name: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'stash'; index: number }
  | { kind: 'empty'; panel: GitPanelId };

export interface GitPanelLists {
  files: readonly GitFileRow[];
  branches: readonly string[];
  commits: readonly string[];
  stashes: readonly number[];
}

/** What the right pane should show for whichever panel currently has focus, derived from the
 * selection state and each panel's current list. */
export function deriveGitRightPane(
  state: GitPanelSelection,
  lists: GitPanelLists
): GitRightPane {
  const panel = state.focused;
  if (panel === 'status') return { kind: 'status' };
  if (panel === 'files') {
    const row = lists.files[state.index.files];
    return row === undefined
      ? { kind: 'empty', panel }
      : { kind: 'file', section: row.section, path: row.path };
  }
  if (panel === 'branches') {
    const name = lists.branches[state.index.branches];
    return name === undefined
      ? { kind: 'empty', panel }
      : { kind: 'branch', name };
  }
  if (panel === 'commits') {
    const sha = lists.commits[state.index.commits];
    return sha === undefined
      ? { kind: 'empty', panel }
      : { kind: 'commit', sha };
  }
  const index = lists.stashes[state.index.stashes];
  return index === undefined
    ? { kind: 'empty', panel }
    : { kind: 'stash', index };
}
