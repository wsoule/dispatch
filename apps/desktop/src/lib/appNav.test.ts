import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_GRAPH_SCOPE,
  type GlobalView,
  globalViewDestination,
  initialNavState,
  keyAction,
  NAV_SETTINGS_PAGES,
  type NavAction,
  type NavDestination,
  navReducer,
  type NavState,
  type ProjectView,
  projectViewDestination,
  samePlace,
  TASK_TABS,
} from './appNav';
import { resolveChordKey } from './keyboard';

function run(actions: NavAction[], from: NavState = initialNavState): NavState {
  return actions.reduce(navReducer, from);
}

// Every ProjectView, so adding one without a home fails here and in tsc.
const EVERY_PROJECT_VIEW: Record<ProjectView, true> = {
  cockpit: true,
  overview: true,
  board: true,
  projects: true,
  live: true,
  runs: true,
  branches: true,
  landed: true,
  landing: true,
  review: true,
  inbox: true,
  threads: true,
  timeline: true,
  graph: true,
  'brain-dump': true,
  design: true,
  files: true,
  docs: true,
  terminals: true,
  plans: true,
  draft: true,
  pr: true,
  impact: true,
  task: true,
  'new-task': true,
};

describe('projectViewDestination', () => {
  test.each(Object.keys(EVERY_PROJECT_VIEW) as ProjectView[])(
    '%p has a destination',
    (view) => {
      expect(projectViewDestination(view)).toBeDefined();
    }
  );

  test.each([
    'cockpit',
    'overview',
    'board',
    'inbox',
    'landing',
    'runs',
    'review',
    'landed',
  ] as const)('%p becomes the Tasks list', (view) => {
    expect(projectViewDestination(view)).toEqual({ kind: 'tasks' });
  });

  test('docs becomes the All docs page', () => {
    expect(projectViewDestination('docs')).toEqual({ kind: 'docs' });
  });

  // Threads has a sidebar row; Files, Terminals, Projects (the tree) and Live
  // (work in motion) are reached from the palette, the Projects section's
  // "All" and the Runs page. All of them are pages under Tasks.
  test.each(['files', 'terminals', 'threads', 'projects', 'live'] as const)(
    '%p is a page under Tasks',
    (view) => {
      expect(projectViewDestination(view)).toEqual({
        kind: 'page',
        page: { kind: 'view', view },
      });
    }
  );

  test('the Timeline and the Graph are pages under Tasks with their route parameters', () => {
    expect(projectViewDestination('timeline')).toEqual({
      kind: 'page',
      page: { kind: 'view', view: 'timeline', project: null },
    });
    expect(projectViewDestination('graph')).toEqual({
      kind: 'page',
      page: {
        kind: 'view',
        view: 'graph',
        scope: { level: 'milestone' },
        nodeId: null,
      },
    });
    // Nothing named: the workspace's milestones.
    expect(DEFAULT_GRAPH_SCOPE).toEqual({ level: 'milestone' });
  });

  test('plans and brain dump land on the Overseer, where plans and notes now live', () => {
    for (const view of ['plans', 'brain-dump'] as const) {
      expect(projectViewDestination(view)).toEqual({ kind: 'overseer' });
    }
  });

  test('branches, impact and design land on Tasks', () => {
    for (const view of ['branches', 'impact', 'design'] as const) {
      expect(projectViewDestination(view)).toEqual({ kind: 'tasks' });
    }
  });

  test.each(['task', 'pr', 'draft', 'new-task'] as const)(
    '%p without its id goes nowhere',
    (view) => {
      expect(projectViewDestination(view)).toEqual({ kind: 'none' });
    }
  );
});

describe('globalViewDestination', () => {
  const cases: [GlobalView, NavDestination][] = [
    ['overseer', { kind: 'overseer' }],
    ['settings', { kind: 'settings', page: 'general' }],
    ['sessions', { kind: 'settings', page: 'usage' }],
    ['all-agents', { kind: 'settings', page: 'runs' }],
  ];
  test.each(cases)('%p', (view, expected) => {
    expect(globalViewDestination(view)).toEqual(expected);
  });

  test('a named Settings page wins', () => {
    expect(globalViewDestination('settings', 'integrations')).toEqual({
      kind: 'settings',
      page: 'integrations',
    });
  });
});

describe('the route vocabularies', () => {
  test('every task tab and every Settings page is listed once', () => {
    expect(TASK_TABS).toEqual([
      'auto',
      'spec',
      'run',
      'review',
      'summary',
      'plan',
      'thread',
      'preview',
      'files',
      'terminal',
    ]);
    expect(NAV_SETTINGS_PAGES).toContain('general');
    expect(NAV_SETTINGS_PAGES).toContain('usage');
    expect(NAV_SETTINGS_PAGES).toContain('runs');
    expect(new Set(NAV_SETTINGS_PAGES).size).toBe(NAV_SETTINGS_PAGES.length);
  });
});

describe('navReducer', () => {
  test('a project opens on Overseer with the list behind it', () => {
    expect(initialNavState.mainView).toBe('overseer');
    expect(initialNavState.tasksPage).toEqual({ kind: 'list' });
    expect(initialNavState.activeProjectId).toBeNull();
  });

  test('selectProject records the project and keeps the view and the layout', () => {
    const state = run([
      { type: 'setTasksMode', mode: 'board' },
      { type: 'openTask', taskId: 't-1' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'openSettings' },
      { type: 'openPalette' },
      { type: 'openNewTask' },
      { type: 'selectProject', projectId: '/other' },
    ]);
    expect(state.activeProjectId).toBe('/other');
    expect(state.mainView).toBe('tasks');
    expect(state.tasksMode).toBe('board');
    // Pages, peeks, dialogs and Settings belong to the old project.
    expect(state.tasksPage).toEqual({ kind: 'list' });
    expect(state.peek).toBeNull();
    expect(state.settings).toBeNull();
    expect(state.paletteOpen).toBe(false);
    expect(state.composerOpen).toBe(false);
    expect(state.tasksPreset).toBe('all');
    expect(state.history).toEqual([
      { mainView: 'tasks', tasksPage: { kind: 'list' } },
    ]);
    expect(state.historyIndex).toBe(0);
  });

  test('going to a legacy work view shows the Tasks list', () => {
    const state = run([{ type: 'setProjectView', view: 'inbox' }]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('the Assistant global view is Overseer', () => {
    const state = run([
      { type: 'setProjectView', view: 'board' },
      { type: 'setGlobalView', view: 'overseer' },
    ]);
    expect(state.mainView).toBe('overseer');
  });

  test('a thread opens in a peek and never changes the view', () => {
    const state = run([{ type: 'openThread', messageId: 'm-1' }]);
    expect(state.mainView).toBe('overseer');
    expect(state.peek).toEqual({ kind: 'thread', messageId: 'm-1' });
    expect(state.history).toHaveLength(1);
  });

  test('a thread with no focus is Overseer', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'openThread', messageId: null },
    ]);
    expect(state.peek).toBeNull();
    expect(state.mainView).toBe('overseer');
  });

  test('a hosted view opens as a page under Tasks', () => {
    const state = run([{ type: 'setProjectView', view: 'files' }]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'view', view: 'files' });
  });

  test('a row click in Tasks quick-looks the task in the slide-over, over the list', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'openPeek', taskId: 't-1' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
    expect(state.peek).toEqual({ kind: 'task', taskId: 't-1' });
    // A quick look is not a place: history does not move.
    expect(state.history).toHaveLength(2);
  });

  test('a task peek over Overseer stays a peek', () => {
    const state = run([{ type: 'openPeek', taskId: 't-1' }]);
    expect(state.mainView).toBe('overseer');
    expect(state.peek).toEqual({ kind: 'task', taskId: 't-1' });
  });

  test('a quick look re-pointed at another task swaps the drawer; closePeek clears it', () => {
    const state = run([
      { type: 'openPeek', taskId: 't-1' },
      { type: 'openPeek', taskId: 't-2' },
    ]);
    expect(state.peek).toEqual({ kind: 'task', taskId: 't-2' });
    const closed = navReducer(state, { type: 'closePeek' });
    expect(closed.peek).toBeNull();
    expect(navReducer(closed, { type: 'closePeek' })).toBe(closed);
  });

  test('openTask is the full page under Tasks', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1', tab: 'run', runId: 'r-1' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({
      kind: 'task',
      taskId: 't-1',
      tab: 'run',
      runId: 'r-1',
    });
  });

  test('openTask defaults the tab to auto and the run to none', () => {
    const state = run([{ type: 'openTask', taskId: 't-1' }]);
    expect(state.tasksPage).toEqual({
      kind: 'task',
      taskId: 't-1',
      tab: 'auto',
      runId: null,
    });
  });

  test('opening the full page closes a quick look', () => {
    const state = run([
      { type: 'openPeek', taskId: 't-1' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(state.peek).toBeNull();
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
  });

  test('a task tab change and a run pick stay on the page, off history', () => {
    const opened = run([{ type: 'openTask', taskId: 't-1' }]);
    const state = run(
      [
        { type: 'setTaskTab', tab: 'review' },
        { type: 'openRun', runId: 'r-2' },
      ],
      opened
    );
    expect(state.tasksPage).toMatchObject({ tab: 'review', runId: 'r-2' });
    expect(state.history).toHaveLength(opened.history.length);
    expect(navReducer(state, { type: 'closeRun' }).tasksPage).toMatchObject({
      runId: null,
    });
  });

  test('a tab flip or a run pick off the task page is a no-op', () => {
    for (const action of [
      { type: 'setTaskTab', tab: 'review' },
      { type: 'openRun', runId: 'r-1' },
      { type: 'closeRun' },
    ] as NavAction[]) {
      expect(navReducer(initialNavState, action)).toBe(initialNavState);
    }
  });

  test('re-opening the identical task, tab and run is not a new destination', () => {
    const once = run([{ type: 'openTask', taskId: 't-1', runId: 'r-1' }]);
    const twice = navReducer(once, {
      type: 'openTask',
      taskId: 't-1',
      runId: 'r-1',
    });
    expect(twice.history).toHaveLength(once.history.length);
  });

  test('a doc opens on the docs page under Tasks', () => {
    const state = run([
      { type: 'openDoc', docId: 'd-1', anchor: 'refusal', merge: 'p-1' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({
      kind: 'docs',
      docId: 'd-1',
      anchor: 'refusal',
      merge: 'p-1',
    });
    expect(
      navReducer(state, { type: 'openDoc', docId: 'd-2', anchor: null })
        .tasksPage
    ).toEqual({ kind: 'docs', docId: 'd-2', anchor: null, merge: null });
  });

  test('PR, draft and file pages', () => {
    expect(run([{ type: 'openPr', number: 7 }]).tasksPage).toEqual({
      kind: 'pr',
      number: 7,
    });
    expect(run([{ type: 'openDraft', draftId: 'dr-1' }]).tasksPage).toEqual({
      kind: 'draft',
      draftId: 'dr-1',
    });
    expect(run([{ type: 'openFile', path: 'src/a.ts' }]).tasksPage).toEqual({
      kind: 'file',
      path: 'src/a.ts',
    });
  });

  test('the Timeline page carries its focused lane; a plain Timeline has none', () => {
    const focused = run([{ type: 'openTimeline', project: 'p-1' }]);
    expect(focused.mainView).toBe('tasks');
    expect(focused.tasksPage).toEqual({
      kind: 'view',
      view: 'timeline',
      project: 'p-1',
    });
    expect(
      run([{ type: 'setProjectView', view: 'timeline' }]).tasksPage
    ).toEqual({
      kind: 'view',
      view: 'timeline',
      project: null,
    });
    // Another lane is another place; the same lane is not.
    const other = navReducer(focused, { type: 'openTimeline', project: 'p-2' });
    expect(other.history).toHaveLength(focused.history.length + 1);
    expect(
      navReducer(focused, { type: 'openTimeline', project: 'p-1' }).history
    ).toHaveLength(focused.history.length);
  });

  test('the Graph page carries its scope and arrival box', () => {
    const state = run([
      {
        type: 'openGraph',
        scope: { level: 'issue', projectId: 'p-1' },
        nodeId: 'ms-1',
      },
    ]);
    expect(state.tasksPage).toEqual({
      kind: 'view',
      view: 'graph',
      scope: { level: 'issue', projectId: 'p-1' },
      nodeId: 'ms-1',
    });
    expect(run([{ type: 'setProjectView', view: 'graph' }]).tasksPage).toEqual({
      kind: 'view',
      view: 'graph',
      scope: DEFAULT_GRAPH_SCOPE,
      nodeId: null,
    });
    // Drilling is a destination: back returns to the wider graph.
    const drilled = navReducer(state, {
      type: 'openGraph',
      scope: { level: 'issue', milestoneId: 'ms-1' },
      nodeId: null,
    });
    expect(drilled.history).toHaveLength(state.history.length + 1);
    expect(navReducer(drilled, { type: 'back' }).tasksPage).toEqual(
      state.tasksPage
    );
  });

  test('two pages naming the same place compare equal whatever their key order', () => {
    const a: NavState['tasksPage'] = {
      kind: 'view',
      view: 'graph',
      scope: { level: 'issue', projectId: 'p-1' },
      nodeId: null,
    };
    const b: NavState['tasksPage'] = {
      nodeId: null,
      scope: { projectId: 'p-1', level: 'issue' },
      view: 'graph',
      kind: 'view',
    };
    expect(
      samePlace(
        { mainView: 'tasks', tasksPage: a },
        { mainView: 'tasks', tasksPage: b }
      )
    ).toBe(true);
    expect(
      samePlace(
        { mainView: 'tasks', tasksPage: a },
        { mainView: 'overseer', tasksPage: a }
      )
    ).toBe(false);
  });

  test('Settings opens over the current view and keeps it', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'setGlobalView', view: 'settings', page: 'memory' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.settings).toBe('memory');
    expect(run([{ type: 'openSettings' }]).settings).toBe('general');
    expect(run([{ type: 'openSettings', page: 'a2a' }]).settings).toBe('a2a');
  });

  test('Sessions and All agents open their Settings pages', () => {
    expect(run([{ type: 'setGlobalView', view: 'sessions' }]).settings).toBe(
      'usage'
    );
    expect(run([{ type: 'setGlobalView', view: 'all-agents' }]).settings).toBe(
      'runs'
    );
  });

  test('navigating from inside Settings closes it; closeSettings too', () => {
    const state = run([
      { type: 'openSettings' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(state.settings).toBeNull();
    const open = run([{ type: 'openSettings' }]);
    const closed = navReducer(open, { type: 'closeSettings' });
    expect(closed.settings).toBeNull();
    expect(navReducer(closed, { type: 'closeSettings' })).toBe(closed);
  });

  test('escape closes the shortcuts sheet, the palette and the composer, in that order, before anything beneath', () => {
    let state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'openSettings' },
      { type: 'openNewTask' },
      { type: 'openPalette' },
      { type: 'openShortcuts' },
    ]);
    state = navReducer(state, { type: 'escape' });
    expect(state.shortcutsOpen).toBe(false);
    expect(state.paletteOpen).toBe(true);
    state = navReducer(state, { type: 'escape' });
    expect(state.paletteOpen).toBe(false);
    expect(state.composerOpen).toBe(true);
    state = navReducer(state, { type: 'escape' });
    expect(state.composerOpen).toBe(false);
    expect(state.settings).toBe('general');
    expect(state.peek).not.toBeNull();
    expect(state.tasksPage.kind).toBe('task');
  });

  test('escape closes Settings, then the peek, then a page', () => {
    let state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'openSettings' },
    ]);
    state = navReducer(state, { type: 'escape' });
    expect(state.settings).toBeNull();
    expect(state.peek).not.toBeNull();
    state = navReducer(state, { type: 'escape' });
    expect(state.peek).toBeNull();
    expect(state.tasksPage.kind).toBe('task');
    state = navReducer(state, { type: 'escape' });
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('escape on Overseer with nothing open does nothing', () => {
    expect(run([{ type: 'escape' }])).toBe(initialNavState);
  });

  test('the composer is a dialog, not a place: it opens and closes in place', () => {
    const onDocs = run([{ type: 'setProjectView', view: 'docs' }]);
    const opened = navReducer(onDocs, { type: 'openNewTask' });
    expect(opened.composerOpen).toBe(true);
    expect(opened.tasksPage).toEqual(onDocs.tasksPage);
    expect(opened.history).toEqual(onDocs.history);
    // Opening it again changes nothing; closing it returns the same place.
    expect(navReducer(opened, { type: 'openNewTask' })).toBe(opened);
    const closed = navReducer(opened, { type: 'closeNewTask' });
    expect(closed.composerOpen).toBe(false);
    expect(closed.tasksPage).toEqual(onDocs.tasksPage);
    expect(navReducer(closed, { type: 'closeNewTask' })).toBe(closed);
  });

  test('openShortcuts/closeShortcuts flip shortcutsOpen and touch nothing else', () => {
    const opened = navReducer(initialNavState, { type: 'openShortcuts' });
    expect(opened.shortcutsOpen).toBe(true);
    expect(opened.history).toBe(initialNavState.history);
    expect(opened.paletteOpen).toBe(false);
    const closed = navReducer(opened, { type: 'closeShortcuts' });
    expect(closed.shortcutsOpen).toBe(false);
  });

  test('the palette opens, closes and toggles', () => {
    const opened = navReducer(initialNavState, { type: 'togglePalette' });
    expect(opened.paletteOpen).toBe(true);
    expect(navReducer(opened, { type: 'togglePalette' }).paletteOpen).toBe(
      false
    );
    expect(navReducer(opened, { type: 'closePalette' }).paletteOpen).toBe(
      false
    );
    expect(
      navReducer(initialNavState, { type: 'openPalette' }).paletteOpen
    ).toBe(true);
  });
});

describe('history', () => {
  test('back and forward walk views and pages', () => {
    let state = run([
      { type: 'showTasks' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    state = navReducer(state, { type: 'back' });
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
    state = navReducer(state, { type: 'back' });
    expect(state.mainView).toBe('overseer');
    state = navReducer(state, { type: 'forward' });
    state = navReducer(state, { type: 'forward' });
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
  });

  test('back closes a peek rather than leaving it over another page', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'back' },
    ]);
    expect(state.peek).toBeNull();
    expect(state.mainView).toBe('tasks');
  });

  test('back and forward close Settings and a peek rather than carrying them along', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'openSettings' },
      { type: 'back' },
    ]);
    expect(state.settings).toBeNull();
    expect(state.mainView).toBe('overseer');
  });

  test('back and forward close the palette and the shortcuts sheet (Cmd+[ fires with them open), not the composer', () => {
    const back = run([
      { type: 'showTasks' },
      { type: 'openPalette' },
      { type: 'openShortcuts' },
      { type: 'openNewTask' },
      { type: 'back' },
    ]);
    expect(back.mainView).toBe('overseer');
    expect(back.paletteOpen).toBe(false);
    expect(back.shortcutsOpen).toBe(false);
    expect(back.composerOpen).toBe(true);

    const forward = run([
      { type: 'showTasks' },
      { type: 'back' },
      { type: 'openPalette' },
      { type: 'forward' },
    ]);
    expect(forward.mainView).toBe('tasks');
    expect(forward.paletteOpen).toBe(false);
  });

  test('re-selecting the current place does not add an entry', () => {
    const state = run([{ type: 'showOverseer' }, { type: 'showOverseer' }]);
    expect(state.history).toHaveLength(1);
    const tasks = run([
      { type: 'showTasks' },
      { type: 'setProjectView', view: 'inbox' },
    ]);
    expect(tasks.history).toHaveLength(2);
  });

  test('navigating after going back discards the forward entries', () => {
    let state = run([
      { type: 'showTasks' },
      { type: 'setProjectView', view: 'files' },
      { type: 'back' },
      { type: 'setProjectView', view: 'docs' },
    ]);
    state = navReducer(state, { type: 'forward' });
    expect(state.tasksPage).toMatchObject({ kind: 'docs' });
  });

  test('back at the start, and forward at the end, are no-ops', () => {
    expect(navReducer(initialNavState, { type: 'back' })).toBe(initialNavState);
    expect(navReducer(initialNavState, { type: 'forward' })).toBe(
      initialNavState
    );
  });

  test('back restores the run and the tab the task page was opened with', () => {
    let state = run([
      { type: 'openTask', taskId: 't-1', tab: 'run', runId: 'r-1' },
      { type: 'setProjectView', view: 'docs' },
    ]);
    state = navReducer(state, { type: 'back' });
    expect(state.tasksPage).toEqual({
      kind: 'task',
      taskId: 't-1',
      tab: 'run',
      runId: 'r-1',
    });
  });

  test('closing a page returns to the list', () => {
    let state = run([
      { type: 'showTasks' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
    state = navReducer(state, { type: 'closePage' });
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('the board layout is remembered across pages and project switches', () => {
    const state = run([
      { type: 'setTasksMode', mode: 'board' },
      { type: 'openTask', taskId: 't-1' },
      { type: 'closePage' },
      { type: 'selectProject', projectId: '/other' },
    ]);
    expect(state.tasksMode).toBe('board');
  });

  test('the graph is a page under Tasks, not a layout of the list', () => {
    const state = run([
      { type: 'setTasksMode', mode: 'board' },
      { type: 'setProjectView', view: 'graph' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toMatchObject({ kind: 'view', view: 'graph' });
    expect(state.tasksMode).toBe('board');
    // Pressing Tasks, or closing the page, returns to the list as it was.
    expect(navReducer(state, { type: 'closePage' }).tasksPage).toEqual({
      kind: 'list',
    });
  });

  test('history keeps at most fifty places', () => {
    let state = initialNavState;
    for (let i = 0; i < 60; i += 1) {
      state = navReducer(state, { type: 'openTask', taskId: `t-${i}` });
    }
    expect(state.history).toHaveLength(50);
    expect(state.historyIndex).toBe(49);
  });
});

describe('the Tasks preset', () => {
  test('a count opens the list filtered to its bucket', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'showTasks', preset: 'failed' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPreset).toBe('failed');
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('plain Tasks clears the filter and keeps the page', () => {
    const state = run([
      { type: 'showTasks', preset: 'review' },
      { type: 'openTask', taskId: 't-1' },
      { type: 'showOverseer' },
      { type: 'showTasks' },
    ]);
    expect(state.tasksPreset).toBe('all');
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
  });

  test('Issues pressed twice returns to the list', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'setProjectView', view: 'docs' },
      { type: 'showTasks' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('clearing the filter keeps everything else', () => {
    const state = run([
      { type: 'showTasks', preset: 'moving' },
      { type: 'setTasksPreset', preset: 'all' },
    ]);
    expect(state.tasksPreset).toBe('all');
    expect(state.mainView).toBe('tasks');
  });
});

describe('opening an address', () => {
  test('a person or an outside agent opens in a peek over the current view', () => {
    expect(run([{ type: 'openAddress', address: 'human:sam' }]).peek).toEqual({
      kind: 'person',
      address: 'human:sam',
    });
    const state = run([
      { type: 'showTasks' },
      { type: 'openAddress', address: 'a2a:acme' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.peek).toEqual({ kind: 'outside', address: 'a2a:acme' });
  });

  test('a room is a page under Tasks', () => {
    const state = run([{ type: 'openAddress', address: 'channel:release' }]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'room', room: 'release' });
  });

  test('a task is a quick look over the current view', () => {
    const state = run([{ type: 'openAddress', address: 'task:t-1' }]);
    expect(state.peek).toEqual({ kind: 'task', taskId: 't-1' });
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('anything else goes nowhere', () => {
    expect(run([{ type: 'openAddress', address: 'run:r-1' }])).toBe(
      initialNavState
    );
  });
});

describe('keyAction', () => {
  test.each([
    ['goto-overseer', { type: 'showOverseer' }],
    ['goto-home', { type: 'showOverseer' }],
    ['goto-control-room', { type: 'showOverseer' }],
    ['goto-tasks', { type: 'showTasks' }],
    ['goto-inbox', { type: 'showTasks', preset: 'needs-you' }],
    ['goto-live', { type: 'showTasks', preset: 'moving' }],
    ['goto-projects', { type: 'showTasks', preset: 'review' }],
    ['goto-threads', { type: 'setProjectView', view: 'threads' }],
    ['goto-timeline', { type: 'openTimeline', project: null }],
    [
      'goto-graph',
      { type: 'openGraph', scope: { level: 'milestone' }, nodeId: null },
    ],
    ['goto-settings', { type: 'openSettings' }],
  ] as const)('%p', (command, action) => {
    expect(keyAction(command)).toEqual(action);
  });

  test('every g chord lands somewhere of its own', () => {
    const ctx = {
      isTyping: false,
      modalOpen: false,
      pendingPrefix: 'g' as const,
    };
    for (const letter of [
      'h',
      's',
      'i',
      'm',
      't',
      'l',
      'g',
      'r',
      'f',
      'c',
      'a',
      'o',
    ]) {
      const command = resolveChordKey(
        { key: letter, metaKey: false, ctrlKey: false },
        ctx
      );
      expect(command).not.toBeNull();
      if (command === null) continue;
      const action = keyAction(command);
      expect(action).not.toBeNull();
      expect(action).not.toBe('swallow');
    }
  });

  test('⌘1 and ⌘2 are the two views; ⌘3–⌘9 walk the presets after All', () => {
    expect(keyAction('goto-1')).toEqual({ type: 'showOverseer' });
    expect(keyAction('goto-2')).toEqual({ type: 'showTasks' });
    const presets = (['3', '4', '5', '6', '7', '8', '9'] as const).map((n) => {
      const action = keyAction(`goto-${n}`);
      return typeof action === 'object' && action?.type === 'showTasks'
        ? action.preset
        : action;
    });
    expect(presets).toEqual([
      'needs-you',
      'failed',
      'moving',
      'review',
      'ready',
      'landing',
      'landed',
    ]);
  });

  test('the sidebar key and other keys fall through to the app', () => {
    expect(keyAction('toggle-sidebar')).toBeNull();
    expect(keyAction('new-task')).toBeNull();
    expect(keyAction('open-palette')).toBeNull();
  });
});
