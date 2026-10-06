import { describe, expect, test } from 'bun:test';

import type { GlobalView, NavAction, ProjectView } from './appNav';
import {
  appNavReducer,
  globalViewDestination,
  initialAppNavState,
  initialTwoViewsState,
  projectViewDestination,
  type TwoViewsAction,
  type TwoViewsDestination,
  twoViewsReducer,
  type TwoViewsState,
} from './twoViews';

function run(
  actions: (NavAction | TwoViewsAction)[],
  from: TwoViewsState = initialTwoViewsState
): TwoViewsState {
  return actions.reduce(twoViewsReducer, from);
}

// Every ProjectView, so adding one without a two-view home fails here and in tsc.
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
    'projects',
    'live',
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

  test.each([
    'threads',
    'branches',
    'files',
    'terminals',
    'design',
    'impact',
    'brain-dump',
  ] as const)('%p is Classic-only behind a door', (view) => {
    expect(projectViewDestination(view)).toEqual({ kind: 'classic', view });
  });

  test('plans fold into Overseer', () => {
    expect(projectViewDestination('plans')).toEqual({ kind: 'overseer' });
  });

  test.each(['task', 'pr', 'draft', 'new-task'] as const)(
    '%p without its id goes nowhere',
    (view) => {
      expect(projectViewDestination(view)).toEqual({ kind: 'none' });
    }
  );
});

describe('globalViewDestination', () => {
  const cases: [GlobalView, TwoViewsDestination][] = [
    ['overseer', { kind: 'overseer' }],
    ['settings', { kind: 'settings', page: 'general' }],
    ['sessions', { kind: 'settings', page: 'usage' }],
    ['all-agents', { kind: 'settings', page: 'runs' }],
    ['gallery', { kind: 'settings', page: 'developer' }],
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

describe('twoViewsReducer', () => {
  test('a project opens on Overseer with the list behind it', () => {
    expect(initialTwoViewsState.mainView).toBe('overseer');
    expect(initialTwoViewsState.tasksPage).toEqual({ kind: 'list' });
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
  });

  test('a thread with no focus is the Classic Threads door', () => {
    const state = run([{ type: 'openThread', messageId: null }]);
    expect(state.peek).toBeNull();
    expect(state.tasksPage).toEqual({ kind: 'classic', view: 'threads' });
  });

  test('a row click in Tasks opens the task beside the list', () => {
    const state = run([
      { type: 'tv/showTasks' },
      { type: 'openPeek', taskId: 't-1' },
    ]);
    expect(state.tasksPage).toEqual({
      kind: 'task',
      taskId: 't-1',
      tab: 'auto',
      runId: null,
      full: false,
    });
    expect(state.peek).toBeNull();
  });

  test('a task peek over Overseer stays a peek', () => {
    const state = run([{ type: 'openPeek', taskId: 't-1' }]);
    expect(state.mainView).toBe('overseer');
    expect(state.peek).toEqual({ kind: 'task', taskId: 't-1' });
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
      full: true,
    });
  });

  test('a task tab change and a run pick stay on the page', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'setTaskTab', tab: 'review' },
      { type: 'openRun', runId: 'r-2' },
    ]);
    expect(state.tasksPage).toMatchObject({ tab: 'review', runId: 'r-2' });
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
  });

  test('PR, draft and Impact pages', () => {
    expect(run([{ type: 'openPr', number: 7 }]).tasksPage).toEqual({
      kind: 'pr',
      number: 7,
    });
    expect(run([{ type: 'openDraft', draftId: 'dr-1' }]).tasksPage).toEqual({
      kind: 'draft',
      draftId: 'dr-1',
    });
    expect(
      run([{ type: 'openImpact', subject: { kind: 'file', id: 'a.ts' } }])
        .tasksPage
    ).toEqual({ kind: 'classic', view: 'impact' });
  });

  test('Settings opens over the current view and keeps it', () => {
    const state = run([
      { type: 'tv/showTasks' },
      { type: 'setGlobalView', view: 'settings', page: 'memory' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.settings).toBe('memory');
  });

  test('Sessions and All agents open their Settings pages', () => {
    expect(run([{ type: 'setGlobalView', view: 'sessions' }]).settings).toBe(
      'usage'
    );
    expect(run([{ type: 'setGlobalView', view: 'all-agents' }]).settings).toBe(
      'runs'
    );
  });

  test('navigating from inside Settings closes it', () => {
    const state = run([
      { type: 'tv/openSettings' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(state.settings).toBeNull();
  });

  test('escape closes Settings, then the peek, then a page', () => {
    let state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'tv/openSettings' },
    ]);
    state = twoViewsReducer(state, { type: 'escape' });
    expect(state.settings).toBeNull();
    expect(state.peek).not.toBeNull();
    state = twoViewsReducer(state, { type: 'escape' });
    expect(state.peek).toBeNull();
    expect(state.tasksPage.kind).toBe('task');
    state = twoViewsReducer(state, { type: 'escape' });
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('escape on Overseer with nothing open does nothing', () => {
    expect(run([{ type: 'escape' }])).toBe(initialTwoViewsState);
  });

  test('back and forward walk views and pages', () => {
    let state = run([
      { type: 'tv/showTasks' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    state = twoViewsReducer(state, { type: 'back' });
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
    state = twoViewsReducer(state, { type: 'back' });
    expect(state.mainView).toBe('overseer');
    state = twoViewsReducer(state, { type: 'forward' });
    state = twoViewsReducer(state, { type: 'forward' });
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
  });

  test('back closes a peek rather than leaving it over another page', () => {
    const state = run([
      { type: 'tv/showTasks' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'back' },
    ]);
    expect(state.peek).toBeNull();
  });

  test('expanding a split task makes it full; closing a page returns to the list', () => {
    let state = run([
      { type: 'tv/showTasks' },
      { type: 'openPeek', taskId: 't-1' },
      { type: 'tv/expandTask' },
    ]);
    expect(state.tasksPage).toMatchObject({ kind: 'task', full: true });
    state = twoViewsReducer(state, { type: 'tv/closePage' });
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('switching project drops pages, peeks and Settings but keeps the view', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'openThread', messageId: 'm-1' },
      { type: 'tv/openSettings' },
      { type: 'selectProject', projectId: '/other' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'list' });
    expect(state.peek).toBeNull();
    expect(state.settings).toBeNull();
  });

  test('graph mode is remembered across pages', () => {
    const state = run([
      { type: 'tv/setTasksMode', mode: 'graph' },
      { type: 'openTask', taskId: 't-1' },
      { type: 'tv/closePage' },
    ]);
    expect(state.tasksMode).toBe('graph');
  });

  test('actions that are not navigation leave the state alone', () => {
    for (const action of [
      { type: 'openPalette' },
      { type: 'closePalette' },
      { type: 'togglePalette' },
      { type: 'openShortcuts' },
      { type: 'closeShortcuts' },
      { type: 'openNewTask' },
      { type: 'closeNewTask' },
      { type: 'closeRun' },
    ] as NavAction[]) {
      expect(twoViewsReducer(initialTwoViewsState, action)).toBe(
        initialTwoViewsState
      );
    }
  });
});

describe('appNavReducer', () => {
  test('a legacy action moves both layouts', () => {
    const state = appNavReducer(initialAppNavState, {
      type: 'openTask',
      taskId: 't-1',
    });
    expect(state.nav.projectView).toBe('task');
    expect(state.twoViews.tasksPage).toMatchObject({ kind: 'task' });
  });

  test('a Two views action leaves Classic alone', () => {
    const state = appNavReducer(initialAppNavState, { type: 'tv/showTasks' });
    expect(state.nav).toBe(initialAppNavState.nav);
    expect(state.twoViews.mainView).toBe('tasks');
  });

  test('an action neither layout acts on keeps the same state', () => {
    // A tab change with no task open is a no-op for both reducers.
    expect(
      appNavReducer(initialAppNavState, { type: 'setTaskTab', tab: 'review' })
    ).toBe(initialAppNavState);
  });
});

describe('the Tasks preset', () => {
  test('a count opens the list filtered to its bucket', () => {
    const state = run([
      { type: 'openTask', taskId: 't-1' },
      { type: 'tv/showTasks', preset: 'failed' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPreset).toBe('failed');
    expect(state.tasksPage).toEqual({ kind: 'list' });
  });

  test('plain Tasks clears the filter and keeps the page', () => {
    const state = run([
      { type: 'tv/showTasks', preset: 'review' },
      { type: 'openPeek', taskId: 't-1' },
      { type: 'tv/showOverseer' },
      { type: 'tv/showTasks' },
    ]);
    expect(state.tasksPreset).toBe('all');
    expect(state.tasksPage).toMatchObject({ kind: 'task', taskId: 't-1' });
  });

  test('clearing the filter keeps everything else', () => {
    const state = run([
      { type: 'tv/showTasks', preset: 'moving' },
      { type: 'tv/setTasksPreset', preset: 'all' },
    ]);
    expect(state.tasksPreset).toBe('all');
    expect(state.mainView).toBe('tasks');
  });
});

describe('opening an address', () => {
  test('a person or an outside agent opens in a peek over the current view', () => {
    expect(
      run([{ type: 'tv/openAddress', address: 'human:sam' }]).peek
    ).toEqual({
      kind: 'person',
      address: 'human:sam',
    });
    const state = run([
      { type: 'tv/showTasks' },
      { type: 'tv/openAddress', address: 'a2a:acme' },
    ]);
    expect(state.mainView).toBe('tasks');
    expect(state.peek).toEqual({ kind: 'outside', address: 'a2a:acme' });
  });

  test('a room is a page under Tasks', () => {
    const state = run([{ type: 'tv/openAddress', address: 'channel:release' }]);
    expect(state.mainView).toBe('tasks');
    expect(state.tasksPage).toEqual({ kind: 'room', room: 'release' });
  });

  test('a task opens beside the list', () => {
    expect(
      run([{ type: 'tv/openAddress', address: 'task:t-1' }]).tasksPage
    ).toMatchObject({ kind: 'task', taskId: 't-1', full: false });
  });

  test('anything else goes nowhere', () => {
    expect(run([{ type: 'tv/openAddress', address: 'run:r-1' }])).toBe(
      initialTwoViewsState
    );
  });
});
