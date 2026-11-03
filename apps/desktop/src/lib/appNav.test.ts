import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_GRAPH_SCOPE,
  escapeLeavesNav,
  type GlobalView,
  globalViewDestination,
  initialNavState,
  keyAction,
  NAV_SETTINGS_PAGES,
  type NavAction,
  type NavDestination,
  navReducer,
  type NavState,
  onLivePage,
  type ProjectView,
  projectViewDestination,
  samePlace,
  SETTINGS_PAGE_LABELS,
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
    expect(NAV_SETTINGS_PAGES).toEqual(
      Object.keys(SETTINGS_PAGE_LABELS) as typeof NAV_SETTINGS_PAGES
    );
  });

  test('every Settings page has the name the rail and the crumbs show', () => {
    expect(SETTINGS_PAGE_LABELS.general).toBe('General');
    expect(SETTINGS_PAGE_LABELS.team).toBe('Members');
    expect(SETTINGS_PAGE_LABELS.integrations).toBe('Linear');
    expect(SETTINGS_PAGE_LABELS.daemon).toBe('Background');
    expect(SETTINGS_PAGE_LABELS.runs).toBe('Runs');
    for (const page of NAV_SETTINGS_PAGES) {
      expect(SETTINGS_PAGE_LABELS[page]).not.toBe('');
    }
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

  // Settings is an overlay place (Q11): it fills the main column over the
  // recorded place, and leaving it in any way returns there.
  describe('Settings as an overlay place', () => {
    const onTasks = run([{ type: 'showTasks' }]);
    const open = navReducer(onTasks, { type: 'openSettings', page: 'agents' });

    test('opening it records no place', () => {
      expect(open.settings).toBe('agents');
      expect(open.history).toEqual(onTasks.history);
      expect(open.historyIndex).toBe(onTasks.historyIndex);
    });

    test.each<[string, NavAction]>([
      ['showTasks', { type: 'showTasks' }],
      ['showOverseer', { type: 'showOverseer' }],
      ['openPeek', { type: 'openPeek', taskId: 't-1' }],
      ['openThread', { type: 'openThread', messageId: 'm-1' }],
      ['openAddress', { type: 'openAddress', address: 'human:ana' }],
      ['openTask', { type: 'openTask', taskId: 't-1' }],
      ['back', { type: 'back' }],
      ['selectProject', { type: 'selectProject', projectId: '/other' }],
      ['escape', { type: 'escape' }],
      ['closeSettings', { type: 'closeSettings' }],
    ])('%s closes it', (_name, action) => {
      expect(navReducer(open, action).settings).toBeNull();
    });

    test('forward closes it', () => {
      const back = navReducer(onTasks, { type: 'back' });
      const reopened = navReducer(back, { type: 'openSettings' });
      const forward = navReducer(reopened, { type: 'forward' });
      expect(forward.settings).toBeNull();
      expect(forward.mainView).toBe('tasks');
    });

    test('escape returns to the place it opened over', () => {
      const closed = navReducer(open, { type: 'escape' });
      expect(closed.mainView).toBe('tasks');
      expect(closed.tasksPage).toEqual(onTasks.tasksPage);
      expect(closed.history).toEqual(onTasks.history);
    });

    test('a peek that was open stays in state beneath it and is back once it closes', () => {
      const peeked = run([
        { type: 'openThread', messageId: 'm-1' },
        { type: 'openSettings' },
      ]);
      expect(peeked.settings).toBe('general');
      expect(peeked.peek).toEqual({ kind: 'thread', messageId: 'm-1' });
      const closed = navReducer(peeked, { type: 'escape' });
      expect(closed.settings).toBeNull();
      expect(closed.peek).toEqual({ kind: 'thread', messageId: 'm-1' });
    });

    test('back over a hidden peek leaves Settings in one press, not the unseen peek alone', () => {
      const peeked = navReducer(
        navReducer(onTasks, { type: 'openThread', messageId: 'm-1' }),
        { type: 'openSettings' }
      );
      const back = navReducer(peeked, { type: 'back' });
      expect(back.settings).toBeNull();
      expect(back.peek).toBeNull();
      // There was somewhere to go back to, so it steps there as back always does.
      expect(back.historyIndex).toBe(onTasks.historyIndex - 1);
    });

    test('forward with nothing ahead still leaves Settings, in place', () => {
      const fresh = run([{ type: 'openSettings', page: 'agents' }]);
      const forward = navReducer(fresh, { type: 'forward' });
      expect(forward.settings).toBeNull();
      expect(forward.history).toEqual(fresh.history);
      expect(forward.historyIndex).toBe(fresh.historyIndex);
    });

    test('back with no history behind closes Settings and the peek it hid', () => {
      const fresh = run([
        { type: 'openThread', messageId: 'm-1' },
        { type: 'openSettings' },
      ]);
      expect(fresh.historyIndex).toBe(0);
      const back = navReducer(fresh, { type: 'back' });
      expect(back.settings).toBeNull();
      expect(back.peek).toBeNull();
      expect(back.history).toEqual(fresh.history);
    });
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

  describe('the Live page sits under Runs', () => {
    // Where its Live button is pressed: the Runs page over the Tasks list.
    const runs = run([
      { type: 'showTasks' },
      { type: 'openSettings', page: 'runs' },
    ]);
    const live = navReducer(runs, { type: 'setProjectView', view: 'live' });

    test('opening it from Runs closes Settings and records Live as the place', () => {
      expect(onLivePage(live)).toBe(true);
      expect(live.settings).toBeNull();
      expect(live.history.at(-1)).toEqual({
        mainView: 'tasks',
        tasksPage: { kind: 'view', view: 'live' },
      });
    });

    test.each([['closePage'], ['escape']] as const)(
      '%s goes back one place and opens Runs over it, exactly where Live was opened',
      (type) => {
        const left = navReducer(live, { type });
        expect(onLivePage(left)).toBe(false);
        expect(left.settings).toBe('runs');
        expect(left.mainView).toBe(runs.mainView);
        expect(left.tasksPage).toEqual(runs.tasksPage);
        expect(left.history).toEqual(live.history);
        expect(left.historyIndex).toBe(live.historyIndex - 1);
        // A second Escape closes Runs for the list, never bouncing back to Live.
        const closed = navReducer(left, { type: 'escape' });
        expect(closed.settings).toBeNull();
        expect(closed.tasksPage).toEqual({ kind: 'list' });
      }
    );

    test('opened from the Overseer by the palette, leaving it opens Runs over the Overseer', () => {
      const fromOverseer = run([{ type: 'setProjectView', view: 'live' }]);
      const left = navReducer(fromOverseer, { type: 'escape' });
      expect(left.mainView).toBe('overseer');
      expect(left.settings).toBe('runs');
    });

    test('with no place behind it (a reload on #/live), Runs opens over the Tasks list', () => {
      const reloaded = navReducer(
        {
          ...initialNavState,
          mainView: 'tasks',
          tasksPage: { kind: 'view', view: 'live' },
          history: [
            { mainView: 'tasks', tasksPage: { kind: 'view', view: 'live' } },
          ],
        },
        { type: 'closePage' }
      );
      expect(reloaded.settings).toBe('runs');
      expect(reloaded.mainView).toBe('tasks');
      expect(reloaded.tasksPage).toEqual({ kind: 'list' });
      // Closing Runs then shows the list, not Live again.
      expect(navReducer(reloaded, { type: 'escape' }).tasksPage).toEqual({
        kind: 'list',
      });
    });

    test('a peek over Live closes first; the page is left on the next Escape', () => {
      const peeked = navReducer(live, { type: 'openPeek', taskId: 't-1' });
      const once = navReducer(peeked, { type: 'escape' });
      expect(once.peek).toBeNull();
      expect(onLivePage(once)).toBe(true);
      expect(navReducer(once, { type: 'escape' }).settings).toBe('runs');
    });

    test('every other page still closes to the Tasks list', () => {
      for (const view of [
        'files',
        'terminals',
        'projects',
        'threads',
      ] as const) {
        const left = run([
          { type: 'setProjectView', view },
          { type: 'closePage' },
        ]);
        expect(left.tasksPage).toEqual({ kind: 'list' });
        expect(left.settings).toBeNull();
      }
    });
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

describe('the routed project', () => {
  test('a showTasks naming a project narrows the list to it, with or without a preset', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'showTasks', project: 'p-store' },
    ]);
    expect(state.tasksProject).toBe('p-store');
    expect(state.tasksPreset).toBe('all');
    expect(state.tasksPage).toEqual({ kind: 'list' });
    const failed = run([
      { type: 'showTasks', preset: 'failed', project: 'p-store' },
    ]);
    expect(failed.tasksProject).toBe('p-store');
    expect(failed.tasksPreset).toBe('failed');
  });

  test('a preset tab, the layout and a page keep it; any other showTasks clears it', () => {
    const narrowed = run([
      { type: 'showTasks', project: 'p-store' },
      { type: 'setTasksPreset', preset: 'moving' },
      { type: 'setTasksMode', mode: 'board' },
      { type: 'openTask', taskId: 't-1' },
      { type: 'closePage' },
    ]);
    expect(narrowed.tasksProject).toBe('p-store');
    expect(run([{ type: 'showTasks' }], narrowed).tasksProject).toBeNull();
    expect(
      run([{ type: 'showTasks', preset: 'needs-you' }], narrowed).tasksProject
    ).toBeNull();
    expect(
      run([{ type: 'showOverseer' }, { type: 'showTasks' }], narrowed)
        .tasksProject
    ).toBeNull();
  });

  test('the chip clears it in place, and a project switch drops it', () => {
    const narrowed = run([{ type: 'showTasks', project: 'p-store' }]);
    const cleared = run([{ type: 'setTasksProject', project: null }], narrowed);
    expect(cleared.tasksProject).toBeNull();
    expect(cleared.history).toBe(narrowed.history);
    expect(
      navReducer(cleared, { type: 'setTasksProject', project: null })
    ).toBe(cleared);
    expect(
      run([{ type: 'selectProject', projectId: '/other' }], narrowed)
        .tasksProject
    ).toBeNull();
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
    ['quick-open', { type: 'openQuickOpen' }],
  ] as const)('%p', (command, action) => {
    expect(keyAction(command)).toEqual(action);
  });

  test('⌘P over a modal is swallowed: claimed, nothing dispatched', () => {
    expect(keyAction('quick-open-blocked')).toBe('swallow');
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

  test('⌘1 and ⌘2 open the Overseer and Tasks; ⌘3–⌘9 walk the presets after All', () => {
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

// App's Escape command hands the Overseer's focus back to the talk only when
// the app has nothing of its own above it to close first.
describe('escapeLeavesNav', () => {
  test('nothing open on the Overseer: Escape is the view’s to take', () => {
    expect(initialNavState.mainView).toBe('overseer');
    expect(escapeLeavesNav(initialNavState)).toBe(true);
  });

  test('a peek, Settings or the palette above it take Escape first', () => {
    const peeked = navReducer(initialNavState, {
      type: 'openThread',
      messageId: 'm-1',
    });
    expect(escapeLeavesNav(peeked)).toBe(false);
    expect(
      escapeLeavesNav(navReducer(initialNavState, { type: 'openSettings' }))
    ).toBe(false);
    expect(
      escapeLeavesNav(navReducer(initialNavState, { type: 'togglePalette' }))
    ).toBe(false);
  });
});

// Go to file (⌘P): the Files page with its quick open, which the reducer keeps
// from ever showing with the app palette or reappearing stale.
describe('the Files quick open', () => {
  const FILES = { kind: 'view', view: 'files' } as const;

  test('is closed at first and after a project switch', () => {
    expect(initialNavState.quickOpen).toBe(false);
    const switched = run([
      { type: 'openQuickOpen' },
      { type: 'selectProject', projectId: 'p-2' },
    ]);
    expect(switched.quickOpen).toBe(false);
  });

  test('from Issues it lands on the Files page, open, with the palette closed', () => {
    const state = run([
      { type: 'showTasks' },
      { type: 'openPalette' },
      { type: 'openQuickOpen' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual(FILES);
    expect(state.quickOpen).toBe(true);
    expect(state.paletteOpen).toBe(false);
  });

  test('from the Overseer it lands on the Files page too', () => {
    const state = run([{ type: 'openQuickOpen' }]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual(FILES);
    expect(state.quickOpen).toBe(true);
  });

  test('on the Files page it stays put, adding no history entry', () => {
    const files = run([{ type: 'setProjectView', view: 'files' }]);
    const state = navReducer(files, { type: 'openQuickOpen' });
    expect(state.tasksPage).toEqual(FILES);
    expect(state.history).toBe(files.history);
    expect(state.quickOpen).toBe(true);
  });

  test('on a file page it keeps the open path', () => {
    const file = run([{ type: 'openFile', path: 'src/a.ts' }]);
    const state = navReducer(file, { type: 'openQuickOpen' });
    expect(state.tasksPage).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(state.quickOpen).toBe(true);
  });

  // A task page's Files tab browses that run's worktree: Go to file searches
  // it in place rather than leaving for the project checkout (which would
  // also unmount the run's editor and drop a pending autosave).
  describe('on a task page', () => {
    const RUN_FILES = {
      kind: 'task',
      taskId: 't-1',
      tab: 'files',
      runId: 'r-1',
    } as const;

    test('the run Files tab stays put, adding no history entry', () => {
      const tab = run([
        { type: 'openTask', taskId: 't-1', tab: 'files', runId: 'r-1' },
      ]);
      const state = navReducer(tab, { type: 'openQuickOpen' });
      expect(state.mainView).toBe('tasks');
      expect(state.tasksPage).toEqual(RUN_FILES);
      expect(state.history).toBe(tab.history);
      expect(state.quickOpen).toBe(true);
    });

    test('togglePalette closes it there, and leaving the tab clears it', () => {
      const open = run([
        { type: 'openTask', taskId: 't-1', tab: 'files', runId: 'r-1' },
        { type: 'openQuickOpen' },
      ]);
      const toggled = navReducer(open, { type: 'togglePalette' });
      expect(toggled.paletteOpen).toBe(true);
      expect(toggled.quickOpen).toBe(false);
      const left = navReducer(open, { type: 'setTaskTab', tab: 'run' });
      expect(left.quickOpen).toBe(false);
      const escaped = navReducer(open, { type: 'escape' });
      expect(escaped.quickOpen).toBe(false);
      expect(escaped.tasksPage).toEqual(RUN_FILES);
    });

    test('any other tab goes to the project Files page', () => {
      const state = run([
        { type: 'openTask', taskId: 't-1', tab: 'run', runId: 'r-1' },
        { type: 'openQuickOpen' },
      ]);
      expect(state.tasksPage).toEqual(FILES);
      expect(state.quickOpen).toBe(true);
    });
  });

  test('over Settings on the Files page it closes Settings', () => {
    const state = run([
      { type: 'setProjectView', view: 'files' },
      { type: 'openSettings' },
      { type: 'openQuickOpen' },
    ]);
    expect(state.settings).toBeNull();
    expect(state.quickOpen).toBe(true);
  });

  test('closeQuickOpen closes it, and is a no-op when closed', () => {
    const open = run([{ type: 'openQuickOpen' }]);
    expect(navReducer(open, { type: 'closeQuickOpen' }).quickOpen).toBe(false);
    expect(navReducer(initialNavState, { type: 'closeQuickOpen' })).toBe(
      initialNavState
    );
  });

  test('togglePalette opens the palette and closes the quick open; toggling it shut leaves it closed', () => {
    const toggled = run([{ type: 'openQuickOpen' }, { type: 'togglePalette' }]);
    expect(toggled.paletteOpen).toBe(true);
    expect(toggled.quickOpen).toBe(false);
    const shut = navReducer(toggled, { type: 'togglePalette' });
    expect(shut.paletteOpen).toBe(false);
    expect(shut.quickOpen).toBe(false);
  });

  test.each([
    ['openPalette', { type: 'openPalette' }],
    ['openShortcuts', { type: 'openShortcuts' }],
    ['openSettings', { type: 'openSettings' }],
    ['setGlobalView settings', { type: 'setGlobalView', view: 'settings' }],
    ['openNewTask', { type: 'openNewTask' }],
    ['openPeek', { type: 'openPeek', taskId: 't-1' }],
    ['openThread', { type: 'openThread', messageId: 'm-1' }],
  ] as const)('%s closes it', (_name, action) => {
    const open = run([{ type: 'openQuickOpen' }]);
    expect(navReducer(open, action).quickOpen).toBe(false);
  });

  test('navigating away clears it, so Files never reopens with it stale', () => {
    const away = run([{ type: 'openQuickOpen' }, { type: 'showOverseer' }]);
    expect(away.quickOpen).toBe(false);
    const back = navReducer(away, { type: 'setProjectView', view: 'files' });
    expect(back.tasksPage).toEqual(FILES);
    expect(back.quickOpen).toBe(false);
  });

  test('back and forward clear it', () => {
    const open = run([
      { type: 'showTasks' },
      { type: 'openQuickOpen' },
      { type: 'showOverseer' },
      { type: 'back' },
    ]);
    expect(open.tasksPage).toEqual(FILES);
    expect(open.quickOpen).toBe(false);
    const reopened = navReducer(open, { type: 'openQuickOpen' });
    expect(navReducer(reopened, { type: 'back' }).quickOpen).toBe(false);
  });

  test('escape closes it before the page beneath', () => {
    const open = run([{ type: 'openQuickOpen' }]);
    const escaped = navReducer(open, { type: 'escape' });
    expect(escaped.quickOpen).toBe(false);
    expect(escaped.tasksPage).toEqual(FILES);
    expect(escapeLeavesNav(open)).toBe(false);
  });
});
