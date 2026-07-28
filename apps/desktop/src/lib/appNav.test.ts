import { describe, expect, test } from 'bun:test';

import type { NavState } from './appNav';
import { initialNavState, navReducer } from './appNav';

describe('navReducer', () => {
  test('selectProject switches section to project, defaults to overview, and clears peek/run', () => {
    const state: NavState = {
      ...initialNavState,
      section: 'global',
      globalView: 'settings',
      projectView: 'plans',
      peekTaskId: 'task-1',
      activeRunId: 'run-1',
    };
    const next = navReducer(state, {
      type: 'selectProject',
      projectId: 'proj-a',
    });
    expect(next.section).toBe('project');
    expect(next.activeProjectId).toBe('proj-a');
    expect(next.projectView).toBe('overview');
    expect(next.peekTaskId).toBeNull();
    expect(next.activeRunId).toBeNull();
  });

  test('setProjectView to runs preserves an existing activeRunId', () => {
    const state: NavState = { ...initialNavState, activeRunId: 'run-1' };
    const next = navReducer(state, { type: 'setProjectView', view: 'runs' });
    expect(next.projectView).toBe('runs');
    expect(next.activeRunId).toBe('run-1');
  });

  test('setProjectView away from runs clears activeRunId', () => {
    const state: NavState = {
      ...initialNavState,
      projectView: 'runs',
      activeRunId: 'run-1',
    };
    const next = navReducer(state, { type: 'setProjectView', view: 'board' });
    expect(next.projectView).toBe('board');
    expect(next.activeRunId).toBeNull();
  });

  test('setGlobalView switches section to global', () => {
    const next = navReducer(initialNavState, {
      type: 'setGlobalView',
      view: 'all-agents',
    });
    expect(next.section).toBe('global');
    expect(next.globalView).toBe('all-agents');
  });

  test('setGlobalView clears an open peek — it should never render over Settings/Sessions', () => {
    const state: NavState = { ...initialNavState, peekTaskId: 'task-1' };
    const next = navReducer(state, { type: 'setGlobalView', view: 'settings' });
    expect(next.peekTaskId).toBeNull();
  });

  test('openPeek/closePeek toggle peekTaskId', () => {
    const opened = navReducer(initialNavState, {
      type: 'openPeek',
      taskId: 'task-1',
    });
    expect(opened.peekTaskId).toBe('task-1');
    const closed = navReducer(opened, { type: 'closePeek' });
    expect(closed.peekTaskId).toBeNull();
  });

  test('openRun/closeRun toggle activeRunId', () => {
    const opened = navReducer(initialNavState, {
      type: 'openRun',
      runId: 'run-1',
    });
    expect(opened.activeRunId).toBe('run-1');
    const closed = navReducer(opened, { type: 'closeRun' });
    expect(closed.activeRunId).toBeNull();
  });

  test('togglePalette flips paletteOpen both ways', () => {
    const opened = navReducer(initialNavState, { type: 'togglePalette' });
    expect(opened.paletteOpen).toBe(true);
    const closed = navReducer(opened, { type: 'togglePalette' });
    expect(closed.paletteOpen).toBe(false);
  });

  test('escape closes the palette first when both palette and peek are open', () => {
    const state: NavState = {
      ...initialNavState,
      paletteOpen: true,
      peekTaskId: 'task-1',
    };
    const next = navReducer(state, { type: 'escape' });
    expect(next.paletteOpen).toBe(false);
    expect(next.peekTaskId).toBe('task-1');
  });

  test('escape closes the peek once the palette is already closed', () => {
    const state: NavState = { ...initialNavState, peekTaskId: 'task-1' };
    const next = navReducer(state, { type: 'escape' });
    expect(next.peekTaskId).toBeNull();
  });

  test('escape is a no-op when neither palette nor peek is open', () => {
    const next = navReducer(initialNavState, { type: 'escape' });
    expect(next).toEqual(initialNavState);
  });

  test('openNewTask opens the full-page creator and remembers where it came from', () => {
    const state: NavState = { ...initialNavState, projectView: 'runs' };
    const next = navReducer(state, { type: 'openNewTask' });
    expect(next.section).toBe('project');
    expect(next.projectView).toBe('new-task');
    expect(next.newTaskReturnView).toBe('runs');
  });

  test('closeNewTask returns to the view the creator was opened from', () => {
    let state = navReducer(
      { ...initialNavState, projectView: 'milestones' },
      { type: 'openNewTask' }
    );
    state = navReducer(state, { type: 'closeNewTask' });
    expect(state.projectView).toBe('milestones');
  });

  test('closeNewTask is a no-op when the creator is not the current view', () => {
    const state: NavState = { ...initialNavState, projectView: 'board' };
    expect(navReducer(state, { type: 'closeNewTask' })).toEqual(state);
  });

  test('opening the creator twice keeps the original return view', () => {
    let state = navReducer(
      { ...initialNavState, projectView: 'brain-dump' },
      { type: 'openNewTask' }
    );
    state = navReducer(state, { type: 'openNewTask' });
    expect(state.newTaskReturnView).toBe('brain-dump');
  });

  test('opening the creator from a global view keeps the last project view as the way back', () => {
    let state = navReducer(
      { ...initialNavState, projectView: 'plans' },
      { type: 'setGlobalView', view: 'settings' }
    );
    state = navReducer(state, { type: 'openNewTask' });
    expect(state.section).toBe('project');
    expect(state.newTaskReturnView).toBe('plans');
  });

  test('escape closes the full-page creator once palette and peek are closed', () => {
    let state = navReducer(
      { ...initialNavState, projectView: 'board' },
      { type: 'openNewTask' }
    );
    state = navReducer(state, { type: 'escape' });
    expect(state.projectView).toBe('board');
  });

  test('escape closes the palette before the full-page creator behind it', () => {
    let state = navReducer(initialNavState, { type: 'openNewTask' });
    state = navReducer(state, { type: 'openPalette' });
    state = navReducer(state, { type: 'escape' });
    expect(state.paletteOpen).toBe(false);
    expect(state.projectView).toBe('new-task');
  });

  // C1 regression guard: `activeRunId` is the *only* place "which run is selected" lives —
  // `useDispatchProject` and `RunsView` both read it directly now (no more hook-internal
  // duplicate). These sequences are exactly what App.tsx's `jumpToRun` (All Agents → a run
  // in another project) and the task peek panel's "View run"/"Review run" button each
  // dispatch, chained through the same reducer instance a real `useReducer` would use.
  test('jumpToRun sequence (selectProject, setProjectView runs, openRun) ends with the run selected', () => {
    let state = navReducer(initialNavState, {
      type: 'selectProject',
      projectId: 'proj-b',
    });
    state = navReducer(state, { type: 'setProjectView', view: 'runs' });
    state = navReducer(state, { type: 'openRun', runId: 'run-42' });

    expect(state.activeProjectId).toBe('proj-b');
    expect(state.projectView).toBe('runs');
    expect(state.activeRunId).toBe('run-42');
  });

  test('the peek panel\'s "view run" sequence (closePeek, setProjectView runs, openRun) selects the run', () => {
    let state: NavState = { ...initialNavState, peekTaskId: 'task-9' };
    state = navReducer(state, { type: 'closePeek' });
    state = navReducer(state, { type: 'setProjectView', view: 'runs' });
    state = navReducer(state, { type: 'openRun', runId: 'run-7' });

    expect(state.peekTaskId).toBeNull();
    expect(state.projectView).toBe('runs');
    expect(state.activeRunId).toBe('run-7');
  });

  test("switching projects mid-run-selection drops the previous project's run id", () => {
    let state = navReducer(initialNavState, {
      type: 'openRun',
      runId: 'run-from-project-a',
    });
    state = navReducer(state, {
      type: 'selectProject',
      projectId: 'proj-b',
    });

    expect(state.activeRunId).toBeNull();
  });
});

describe('history', () => {
  const view = (state: NavState) => `${state.section}:${state.projectView}`;

  test('back returns to where you came from, not a fixed destination', () => {
    let state = initialNavState; // overview
    state = navReducer(state, { type: 'setProjectView', view: 'runs' });
    state = navReducer(state, { type: 'setProjectView', view: 'review' });
    expect(view(state)).toBe('project:review');

    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:runs');
    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:overview');
  });

  test('forward works after going back', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'runs',
    });
    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:overview');
    state = navReducer(state, { type: 'forward' });
    expect(view(state)).toBe('project:runs');
  });

  test('navigating after going back discards the forward entries', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'runs',
    });
    state = navReducer(state, { type: 'setProjectView', view: 'review' });
    state = navReducer(state, { type: 'back' }); // on runs
    state = navReducer(state, { type: 'setProjectView', view: 'plans' });
    // Review is gone from the future; forward must not resurrect it.
    state = navReducer(state, { type: 'forward' });
    expect(view(state)).toBe('project:plans');
  });

  test('back at the start of history is a no-op', () => {
    const state = navReducer(initialNavState, { type: 'back' });
    expect(state).toBe(initialNavState);
  });

  test('re-selecting the current view does not add an entry', () => {
    const state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'overview',
    });
    expect(state.history).toHaveLength(1);
  });

  test('back restores the run that was open on that entry', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'runs',
    });
    state = navReducer(state, { type: 'openRun', runId: 'r-1' });
    state = navReducer(state, { type: 'setProjectView', view: 'plans' });
    state = navReducer(state, { type: 'back' });
    expect(state.activeRunId).toBe('r-1');
  });
});
