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

  test('setProjectView to task preserves an existing activeRunId', () => {
    const state: NavState = { ...initialNavState, activeRunId: 'run-1' };
    const next = navReducer(state, { type: 'setProjectView', view: 'task' });
    expect(next.projectView).toBe('task');
    expect(next.activeRunId).toBe('run-1');
  });

  test('setProjectView to any other view clears activeRunId', () => {
    const state: NavState = {
      ...initialNavState,
      projectView: 'task',
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

  test('setGlobalView routes to the warden chat like any other global view', () => {
    const next = navReducer(initialNavState, {
      type: 'setGlobalView',
      view: 'warden',
    });
    expect(next.section).toBe('global');
    expect(next.globalView).toBe('warden');
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
    const state: NavState = { ...initialNavState, projectView: 'branches' };
    const next = navReducer(state, { type: 'openNewTask' });
    expect(next.section).toBe('project');
    expect(next.projectView).toBe('new-task');
    expect(next.newTaskReturnView).toBe('branches');
  });

  test('closeNewTask returns to the view the creator was opened from', () => {
    let state = navReducer(
      { ...initialNavState, projectView: 'plans' },
      { type: 'openNewTask' }
    );
    state = navReducer(state, { type: 'closeNewTask' });
    expect(state.projectView).toBe('plans');
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

  // C1 regression guard: `activeRunId` is the *only* place "which run is selected" lives.
  // These sequences are exactly what App.tsx's `jumpToRun` (All Agents → a run) and the task
  // peek panel's "View run" button each dispatch, chained through the same reducer instance a
  // real `useReducer` would use — both land on the task view now that Runs is gone.
  test('jumpToRun sequence (selectProject, openTask with the run) ends with the run selected', () => {
    let state = navReducer(initialNavState, {
      type: 'selectProject',
      projectId: 'proj-b',
    });
    state = navReducer(state, {
      type: 'openTask',
      taskId: 'task-42',
      tab: 'chat',
      runId: 'run-42',
    });

    expect(state.activeProjectId).toBe('proj-b');
    expect(state.projectView).toBe('task');
    expect(state.activeRunId).toBe('run-42');
  });

  test('the peek panel\'s "view run" sequence (closePeek, openTask) selects the run', () => {
    let state: NavState = { ...initialNavState, peekTaskId: 'task-9' };
    state = navReducer(state, { type: 'closePeek' });
    state = navReducer(state, {
      type: 'openTask',
      taskId: 'task-9',
      tab: 'chat',
      runId: 'run-7',
    });

    expect(state.peekTaskId).toBeNull();
    expect(state.projectView).toBe('task');
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
    state = navReducer(state, { type: 'setProjectView', view: 'inbox' });
    state = navReducer(state, { type: 'setProjectView', view: 'branches' });
    expect(view(state)).toBe('project:branches');

    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:inbox');
    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:overview');
  });

  test('forward works after going back', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'inbox',
    });
    state = navReducer(state, { type: 'back' });
    expect(view(state)).toBe('project:overview');
    state = navReducer(state, { type: 'forward' });
    expect(view(state)).toBe('project:inbox');
  });

  test('navigating after going back discards the forward entries', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'inbox',
    });
    state = navReducer(state, { type: 'setProjectView', view: 'branches' });
    state = navReducer(state, { type: 'back' }); // on inbox
    state = navReducer(state, { type: 'setProjectView', view: 'plans' });
    // Git is gone from the future; forward must not resurrect it.
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
      view: 'task',
    });
    state = navReducer(state, { type: 'openRun', runId: 'r-1' });
    state = navReducer(state, { type: 'setProjectView', view: 'plans' });
    state = navReducer(state, { type: 'back' });
    expect(state.activeRunId).toBe('r-1');
  });
});

describe('draft page navigation', () => {
  test('openDraft routes to the draft view with that draft selected', () => {
    const next = navReducer(initialNavState, {
      type: 'openDraft',
      draftId: 'd-abc123',
    });
    expect(next.section).toBe('project');
    expect(next.projectView).toBe('draft');
    expect(next.activeDraftId).toBe('d-abc123');
  });

  test('leaving the draft view clears the selected draft', () => {
    const opened = navReducer(initialNavState, {
      type: 'openDraft',
      draftId: 'd-abc123',
    });
    const next = navReducer(opened, { type: 'setProjectView', view: 'board' });
    expect(next.activeDraftId).toBeNull();
  });

  test('selecting a project clears a draft left open in the previous one', () => {
    const opened = navReducer(initialNavState, {
      type: 'openDraft',
      draftId: 'd-abc123',
    });
    const next = navReducer(opened, {
      type: 'selectProject',
      projectId: 'other',
    });
    expect(next.activeDraftId).toBeNull();
  });

  test('after openDraft, navigating away and back returns to the draft view with the same activeDraftId', () => {
    let state = navReducer(initialNavState, {
      type: 'openDraft',
      draftId: 'd-1',
    });
    expect(state.projectView).toBe('draft');
    expect(state.activeDraftId).toBe('d-1');

    state = navReducer(state, { type: 'setProjectView', view: 'board' });
    expect(state.projectView).toBe('board');
    expect(state.activeDraftId).toBeNull();

    state = navReducer(state, { type: 'back' });
    expect(state.projectView).toBe('draft');
    expect(state.activeDraftId).toBe('d-1');
  });

  test('navigating back to an entry recorded before any draft was opened leaves activeDraftId as null', () => {
    let state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'board',
    });
    expect(state.activeDraftId).toBeNull();

    state = navReducer(state, {
      type: 'openDraft',
      draftId: 'd-1',
    });
    expect(state.activeDraftId).toBe('d-1');

    state = navReducer(state, { type: 'back' });
    expect(state.projectView).toBe('board');
    expect(state.activeDraftId).toBeNull();
  });

  test('switching between drafts without leaving the draft view pushes history for each', () => {
    let state = navReducer(initialNavState, {
      type: 'openDraft',
      draftId: 'd-1',
    });
    expect(state.activeDraftId).toBe('d-1');
    expect(state.history.length).toBe(2);

    state = navReducer(state, {
      type: 'openDraft',
      draftId: 'd-2',
    });
    expect(state.activeDraftId).toBe('d-2');
    expect(state.history.length).toBe(3);

    state = navReducer(state, { type: 'back' });
    expect(state.projectView).toBe('draft');
    expect(state.activeDraftId).toBe('d-1');
  });
});

describe('retired views', () => {
  test("the retired 'runs' and 'review' views normalize to 'inbox'", () => {
    for (const view of ['runs', 'review'] as const) {
      const next = navReducer(initialNavState, {
        type: 'setProjectView',
        view,
      });
      expect(next.projectView).toBe('inbox');
    }
  });

  test("the retired 'landed' view normalizes to 'landing'", () => {
    const next = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'landed',
    });
    expect(next.projectView).toBe('landing');
    expect(next.history[next.historyIndex]?.projectView).toBe('landing');
  });

  test('a retired view never reaches history, so back cannot land on one', () => {
    const state = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'runs',
    });
    expect(state.history[state.historyIndex]?.projectView).toBe('inbox');
  });

  test('a stored nav state on a retired view returns from the creator to the inbox', () => {
    const stored: NavState = { ...initialNavState, projectView: 'review' };
    let state = navReducer(stored, { type: 'openNewTask' });
    expect(state.newTaskReturnView).toBe('inbox');
    state = navReducer(state, { type: 'closeNewTask' });
    expect(state.projectView).toBe('inbox');
  });
});

describe('pull request page navigation', () => {
  test('openPr routes to the PR view with that number selected', () => {
    const next = navReducer(initialNavState, { type: 'openPr', number: 12 });
    expect(next.section).toBe('project');
    expect(next.projectView).toBe('pr');
    expect(next.activePrNumber).toBe(12);
  });

  test('leaving the PR view clears the selected pull request', () => {
    const opened = navReducer(initialNavState, { type: 'openPr', number: 12 });
    const next = navReducer(opened, { type: 'setProjectView', view: 'inbox' });
    expect(next.activePrNumber).toBeNull();
  });

  test('back returns to the pull request that was open on that entry', () => {
    let state = navReducer(initialNavState, { type: 'openPr', number: 12 });
    state = navReducer(state, { type: 'setProjectView', view: 'board' });
    expect(state.activePrNumber).toBeNull();
    state = navReducer(state, { type: 'back' });
    expect(state.projectView).toBe('pr');
    expect(state.activePrNumber).toBe(12);
  });

  test('escape on the PR view acts as back', () => {
    const onInbox = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'inbox',
    });
    const opened = navReducer(onInbox, { type: 'openPr', number: 12 });
    const escaped = navReducer(opened, { type: 'escape' });
    expect(escaped.projectView).toBe('inbox');
  });

  test('selecting a project drops a pull request left open in the previous one', () => {
    const opened = navReducer(initialNavState, { type: 'openPr', number: 12 });
    const next = navReducer(opened, {
      type: 'selectProject',
      projectId: 'other',
    });
    expect(next.activePrNumber).toBeNull();
  });
});

describe('openTask', () => {
  test('routes to the task view, seeds tab and run, closes the peek', () => {
    const peeked = navReducer(initialNavState, {
      type: 'openPeek',
      taskId: 't-1',
    });
    const state = navReducer(peeked, {
      type: 'openTask',
      taskId: 't-1',
      tab: 'chat',
      runId: 'r-9',
    });
    expect(state.projectView).toBe('task');
    expect(state.activeTaskId).toBe('t-1');
    expect(state.taskTab).toBe('chat');
    expect(state.activeRunId).toBe('r-9');
    expect(state.peekTaskId).toBeNull();
  });

  test('defaults tab to details and run to null', () => {
    const state = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    expect(state.taskTab).toBe('details');
    expect(state.activeRunId).toBeNull();
  });

  test('pushes history so back returns to the previous view', () => {
    const onBoard = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'board',
    });
    const opened = navReducer(onBoard, { type: 'openTask', taskId: 't-1' });
    const back = navReducer(opened, { type: 'back' });
    expect(back.projectView).toBe('board');
    const forward = navReducer(back, { type: 'forward' });
    expect(forward.projectView).toBe('task');
    expect(forward.activeTaskId).toBe('t-1');
    expect(forward.taskTab).toBe('details');
  });

  test('re-opening the identical task/tab/run is not a new destination', () => {
    const once = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
      runId: 'r-1',
    });
    const twice = navReducer(once, {
      type: 'openTask',
      taskId: 't-1',
      runId: 'r-1',
    });
    expect(twice.history.length).toBe(once.history.length);
  });
});

describe('setTaskTab', () => {
  test('switches the tab without a history entry', () => {
    const opened = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    const switched = navReducer(opened, { type: 'setTaskTab', tab: 'diff' });
    expect(switched.taskTab).toBe('diff');
    expect(switched.history.length).toBe(opened.history.length);
  });

  test('is a no-op off the task view', () => {
    const state = navReducer(initialNavState, {
      type: 'setTaskTab',
      tab: 'diff',
    });
    expect(state).toBe(initialNavState);
  });
});

describe('task view teardown', () => {
  test('setProjectView away from task clears activeTaskId and its run', () => {
    const opened = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
      runId: 'r-1',
    });
    const toInbox = navReducer(opened, {
      type: 'setProjectView',
      view: 'inbox',
    });
    expect(toInbox.activeTaskId).toBeNull();
    expect(toInbox.activeRunId).toBeNull();
    const toBoard = navReducer(opened, {
      type: 'setProjectView',
      view: 'board',
    });
    expect(toBoard.activeRunId).toBeNull();
  });

  test('selectProject clears activeTaskId', () => {
    const opened = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    const switched = navReducer(opened, {
      type: 'selectProject',
      projectId: 'p-2',
    });
    expect(switched.activeTaskId).toBeNull();
    expect(switched.projectView).toBe('overview');
  });

  test('escape on the task view acts as back', () => {
    const onBoard = navReducer(initialNavState, {
      type: 'setProjectView',
      view: 'board',
    });
    const opened = navReducer(onBoard, { type: 'openTask', taskId: 't-1' });
    const escaped = navReducer(opened, { type: 'escape' });
    expect(escaped.projectView).toBe('board');
  });

  test('escape still prefers the palette and the peek over the task view', () => {
    const opened = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    const withPeek = navReducer(opened, { type: 'openPeek', taskId: 't-2' });
    const escaped = navReducer(withPeek, { type: 'escape' });
    expect(escaped.peekTaskId).toBeNull();
    expect(escaped.projectView).toBe('task');
  });

  test('escape on a global view is a no-op even with a lingering task view underneath', () => {
    // `setGlobalView` never clears `projectView`, so it can still read 'task' while
    // `section` is 'global' (Settings). Without checking `section` too, escape's task-view
    // branch treats that as "still on the task view" and teleports out of Settings via back.
    const opened = navReducer(initialNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    const inSettings = navReducer(opened, {
      type: 'setGlobalView',
      view: 'settings',
    });
    const escaped = navReducer(inSettings, { type: 'escape' });
    expect(escaped).toEqual(inSettings);
  });
});
