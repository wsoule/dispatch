import { describe, expect, test } from 'bun:test';

import type { GitPanelSelection } from './gitPanels';
import {
  clampGitPanelSelection,
  deriveGitRightPane,
  focusGitPanel,
  GIT_PANEL_IDS,
  INITIAL_GIT_PANEL_SELECTION,
  moveGitSelection,
  preserveGitSelection,
  reconcileGitPanelSelection,
} from './gitPanels';

describe('focusGitPanel', () => {
  test("cycles focus through every panel while preserving each one's own index", () => {
    let state: GitPanelSelection = {
      ...INITIAL_GIT_PANEL_SELECTION,
      index: { status: 0, files: 2, branches: 1, commits: 3, stashes: 0 },
    };
    for (const panel of GIT_PANEL_IDS) {
      state = focusGitPanel(state, panel);
      expect(state.focused).toBe(panel);
    }
    // Moving through every panel and back to the start never touched an index.
    expect(state.index).toEqual({
      status: 0,
      files: 2,
      branches: 1,
      commits: 3,
      stashes: 0,
    });
  });

  test('focusing the already-focused panel is a no-op (same reference)', () => {
    const state = INITIAL_GIT_PANEL_SELECTION;
    expect(focusGitPanel(state, state.focused)).toBe(state);
  });
});

describe('moveGitSelection', () => {
  test('moves down and up within bounds', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'commits');
    state = moveGitSelection(state, 5, 1);
    expect(state.index.commits).toBe(1);
    state = moveGitSelection(state, 5, 1);
    expect(state.index.commits).toBe(2);
    state = moveGitSelection(state, 5, -1);
    expect(state.index.commits).toBe(1);
  });

  test('clamps at the top and bottom of the list', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'files');
    state = moveGitSelection(state, 3, -1);
    expect(state.index.files).toBe(0);
    state = moveGitSelection(state, 3, 1);
    state = moveGitSelection(state, 3, 1);
    state = moveGitSelection(state, 3, 1);
    expect(state.index.files).toBe(2);
  });

  test('an empty list has no selectable row', () => {
    const state = moveGitSelection(
      focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'stashes'),
      0,
      1
    );
    expect(state.index.stashes).toBe(-1);
  });
});

describe('clampGitPanelSelection', () => {
  test('selection lands on the row that slid into a vacated spot when the list shrinks', () => {
    // Five unstaged files, selection on index 2 ("c.ts"). Staging c.ts drops the list to
    // four rows; index 2 should now point at what used to be "d.ts", not reset to 0.
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'files');
    state = withFilesIndex(state, 2);
    state = clampGitPanelSelection(state, 'files', 4);
    expect(state.index.files).toBe(2);
  });

  test('selection clamps to the new last row when the selected row itself is removed', () => {
    // Selection was on the last of 5 rows (index 4); the list shrinks to 4 rows.
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'files');
    state = withFilesIndex(state, 4);
    state = clampGitPanelSelection(state, 'files', 4);
    expect(state.index.files).toBe(3);
  });

  test('an emptied list clamps to -1', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'files');
    state = withFilesIndex(state, 0);
    state = clampGitPanelSelection(state, 'files', 0);
    expect(state.index.files).toBe(-1);
  });

  test('only clamps the named panel, leaving the others alone', () => {
    let state: GitPanelSelection = {
      ...INITIAL_GIT_PANEL_SELECTION,
      index: { status: 0, files: 5, branches: 5, commits: 0, stashes: 0 },
    };
    state = clampGitPanelSelection(state, 'files', 2);
    expect(state.index.files).toBe(1);
    expect(state.index.branches).toBe(5);
  });
});

function withFilesIndex(
  state: GitPanelSelection,
  index: number
): GitPanelSelection {
  return { ...state, index: { ...state.index, files: index } };
}

describe('deriveGitRightPane', () => {
  const lists = {
    files: [
      { section: 'staged' as const, path: 'a.ts' },
      { section: 'unstaged' as const, path: 'b.ts' },
    ],
    branches: ['main', 'dispatch/t-1'],
    commits: ['sha1', 'sha2'],
    stashes: [0, 1],
  };

  test('status panel always shows the status pane, regardless of index', () => {
    const state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'status');
    expect(deriveGitRightPane(state, lists)).toEqual({ kind: 'status' });
  });

  test('files panel shows the selected file diff', () => {
    const state = withFilesIndex(
      focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'files'),
      1
    );
    expect(deriveGitRightPane(state, lists)).toEqual({
      kind: 'file',
      section: 'unstaged',
      path: 'b.ts',
    });
  });

  test('branches panel shows the selected branch detail', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'branches');
    state = moveGitSelection(state, 2, 1);
    expect(deriveGitRightPane(state, lists)).toEqual({
      kind: 'branch',
      name: 'dispatch/t-1',
    });
  });

  test('commits panel shows the selected commit diff', () => {
    const state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'commits');
    expect(deriveGitRightPane(state, lists)).toEqual({
      kind: 'commit',
      sha: 'sha1',
    });
  });

  test('stashes panel shows the selected stash', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'stashes');
    state = moveGitSelection(state, 2, 1);
    expect(deriveGitRightPane(state, lists)).toEqual({
      kind: 'stash',
      index: 1,
    });
  });

  test('an empty list derives an empty pane naming the focused panel', () => {
    const state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'stashes');
    expect(deriveGitRightPane(state, { ...lists, stashes: [] })).toEqual({
      kind: 'empty',
      panel: 'stashes',
    });
  });
});

describe('preserveGitSelection / reconcileGitPanelSelection', () => {
  test('follows the same commit sha when new commits are inserted above it', () => {
    const prev = ['sha2', 'sha1'];
    const next = ['sha3', 'sha2', 'sha1'];
    const index = preserveGitSelection(0, prev, next, (sha) => sha);
    expect(index).toBe(1);
  });

  test('falls back to a clamped index when the selected row is gone', () => {
    const prev = ['sha2', 'sha1'];
    const next = ['sha3'];
    const index = preserveGitSelection(0, prev, next, (sha) => sha);
    expect(index).toBe(0);
  });

  test('reconcileGitPanelSelection applies the same rule to one panel of full state', () => {
    let state = focusGitPanel(INITIAL_GIT_PANEL_SELECTION, 'commits');
    state = moveGitSelection(state, 2, 1); // select index 1: 'sha1'
    const prev = ['sha2', 'sha1'];
    const next = ['sha3', 'sha2', 'sha1'];
    state = reconcileGitPanelSelection(
      state,
      'commits',
      prev,
      next,
      (sha) => sha
    );
    expect(state.index.commits).toBe(2);
  });
});
