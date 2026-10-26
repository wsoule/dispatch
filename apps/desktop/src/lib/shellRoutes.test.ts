import { describe, expect, test } from 'bun:test';

import type { NavAction } from './appNav';
import {
  currentShellDestination,
  hrefFor,
  MOD_KEY,
  parseShellHref,
  PROJECTS_HREF,
  resolveShellHref,
  SHELL_ROUTES,
  type ShellDestination,
  shellRoute,
  shellShortcut,
  taskHref,
  timelineHref,
} from './shellRoutes';
import {
  initialTwoViewsState,
  type TwoViewsAction,
  twoViewsReducer,
  type TwoViewsState,
} from './twoViews';

const EVERY_DESTINATION: readonly ShellDestination[] = [
  'overseer',
  'issues',
  'needs-you',
  'timeline',
  'graph',
  'threads',
  'docs',
  'runs',
  'settings',
];

function after(
  actions: (NavAction | TwoViewsAction)[],
  from: TwoViewsState = initialTwoViewsState
): TwoViewsState {
  return actions.reduce(twoViewsReducer, from);
}

describe('the route table', () => {
  test('lists every destination once, each at its own hash', () => {
    expect(SHELL_ROUTES.map((route) => route.id)).toEqual([
      ...EVERY_DESTINATION,
    ]);
    for (const id of EVERY_DESTINATION) {
      expect(shellRoute(id).href).toBe(`#/${id}`);
      expect(parseShellHref(hrefFor(id))).toBe(id);
    }
  });

  test('the keys are the ones lib/keyboard.ts binds', () => {
    expect(shellShortcut(shellRoute('overseer'), '⌘')).toEqual(['⌘', '1']);
    expect(shellShortcut(shellRoute('issues'), 'Ctrl')).toEqual(['Ctrl', '2']);
    expect(shellShortcut(shellRoute('needs-you'), '⌘')).toEqual(['G', 'I']);
    expect(shellShortcut(shellRoute('threads'), '⌘')).toEqual(['G', 'M']);
    // `g t` is Tasks, so the Timeline takes `g l`; the Graph owns `g g`.
    expect(shellShortcut(shellRoute('timeline'), '⌘')).toEqual(['G', 'L']);
    expect(shellShortcut(shellRoute('graph'), '⌘')).toEqual(['G', 'G']);
    expect(shellShortcut(shellRoute('settings'), '⌘')).toEqual(['G', 'S']);
    expect(shellShortcut(shellRoute('docs'), '⌘')).toBeUndefined();
    expect(shellShortcut(shellRoute('runs'), '⌘')).toBeUndefined();
    // The table never prints the token itself.
    expect(shellRoute('overseer').shortcut).toContain(MOD_KEY);
  });

  test('each action is what the top bar dispatched for that word', () => {
    expect(shellRoute('overseer').action).toEqual({ type: 'tv/showOverseer' });
    expect(shellRoute('issues').action).toEqual({ type: 'tv/showTasks' });
    expect(shellRoute('needs-you').action).toEqual({
      type: 'tv/showTasks',
      preset: 'needs-you',
    });
    expect(shellRoute('threads').action).toEqual({
      type: 'setProjectView',
      view: 'threads',
    });
    expect(shellRoute('timeline').action).toEqual({
      type: 'setProjectView',
      view: 'timeline',
    });
    expect(shellRoute('graph').action).toEqual({
      type: 'setProjectView',
      view: 'graph',
    });
    expect(shellRoute('docs').action).toEqual({
      type: 'setProjectView',
      view: 'docs',
    });
    expect(shellRoute('runs').action).toEqual({
      type: 'tv/openSettings',
      page: 'runs',
    });
    expect(shellRoute('settings').action).toEqual({ type: 'tv/openSettings' });
  });
});

describe('parseShellHref', () => {
  test('rejects what is not a destination', () => {
    for (const href of [
      '#main',
      '#dispatch-main',
      '/issues',
      '#/issues/',
      '#/task/t-1',
      '#/projects',
      '#/timeline?project=p-1',
      'https://example.com/#/issues',
      '',
    ]) {
      expect(parseShellHref(href)).toBeNull();
    }
  });
});

describe('resolveShellHref', () => {
  test('a destination, a task, the projects list, or nothing', () => {
    expect(resolveShellHref('#/threads')).toEqual({
      kind: 'destination',
      id: 'threads',
    });
    expect(resolveShellHref(taskHref('t-9b2d14'))).toEqual({
      kind: 'task',
      taskId: 't-9b2d14',
    });
    expect(resolveShellHref(PROJECTS_HREF)).toEqual({ kind: 'projects' });
    expect(resolveShellHref('#main')).toBeNull();
    expect(resolveShellHref('#/task/')).toBeNull();
  });

  test('task ids survive the href round trip', () => {
    const id = 'weird id/with:chars';
    expect(resolveShellHref(taskHref(id))).toEqual({
      kind: 'task',
      taskId: id,
    });
  });

  test('a timeline link naming a project focuses its lane', () => {
    expect(timelineHref('p-1')).toBe('#/timeline?project=p-1');
    expect(resolveShellHref(timelineHref('p-1'))).toEqual({
      kind: 'timeline',
      projectId: 'p-1',
    });
    const id = 'weird id/with:chars&more';
    expect(resolveShellHref(timelineHref(id))).toEqual({
      kind: 'timeline',
      projectId: id,
    });
    // The bare destination stays a destination; a stray query is nothing.
    expect(resolveShellHref('#/timeline')).toEqual({
      kind: 'destination',
      id: 'timeline',
    });
    expect(resolveShellHref('#/timeline?lane=p-1')).toBeNull();
  });
});

describe('currentShellDestination', () => {
  test('the app opens on Overseer', () => {
    expect(currentShellDestination(initialTwoViewsState)).toBe('overseer');
  });

  test('the Tasks list is Issues under any preset but Needs you', () => {
    const tasks = after([{ type: 'tv/showTasks' }]);
    expect(currentShellDestination(tasks)).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'tv/setTasksPreset', preset: 'failed' }], tasks)
      )
    ).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'tv/showTasks', preset: 'needs-you' }])
      )
    ).toBe('needs-you');
  });

  test('a task quick-looked over the list, or open as its page, keeps the list row current', () => {
    const peeked = after([
      { type: 'tv/showTasks' },
      { type: 'openPeek', taskId: 't-1' },
    ]);
    expect(peeked.peek).toEqual({ kind: 'task', taskId: 't-1' });
    expect(currentShellDestination(peeked)).toBe('issues');
    const open = after([
      { type: 'tv/showTasks' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(open.tasksPage.kind).toBe('task');
    expect(currentShellDestination(open)).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'tv/setTasksPreset', preset: 'needs-you' }], open)
      )
    ).toBe('needs-you');
  });

  test('the timeline page is its own row', () => {
    const timeline = after([{ type: 'setProjectView', view: 'timeline' }]);
    expect(timeline.tasksPage).toEqual({ kind: 'view', view: 'timeline' });
    expect(currentShellDestination(timeline)).toBe('timeline');
    // A milestone quick-looked over the chart keeps the row.
    expect(
      currentShellDestination(
        after([{ type: 'openPeek', taskId: 'm-1' }], timeline)
      )
    ).toBe('timeline');
    expect(
      currentShellDestination(after([{ type: 'tv/closePage' }], timeline))
    ).toBe('issues');
  });

  test('the graph page is its own row', () => {
    const graph = after([{ type: 'setProjectView', view: 'graph' }]);
    expect(graph.tasksPage).toEqual({ kind: 'view', view: 'graph' });
    expect(currentShellDestination(graph)).toBe('graph');
    // A node quick-looked over the chart keeps the row.
    expect(
      currentShellDestination(
        after([{ type: 'openPeek', taskId: 'p-1' }], graph)
      )
    ).toBe('graph');
    expect(
      currentShellDestination(after([{ type: 'tv/closePage' }], graph))
    ).toBe('issues');
  });

  test('the projects tree and the live page have no row: Issues stays current', () => {
    for (const view of ['projects', 'live'] as const) {
      const page = after([{ type: 'setProjectView', view }]);
      expect(page.tasksPage).toEqual({ kind: 'view', view });
      expect(currentShellDestination(page)).toBe('issues');
    }
  });

  test('the docs and threads pages are their own rows', () => {
    expect(
      currentShellDestination(after([{ type: 'setProjectView', view: 'docs' }]))
    ).toBe('docs');
    expect(
      currentShellDestination(
        after([{ type: 'openDoc', docId: 'spec', anchor: null }])
      )
    ).toBe('docs');
    expect(
      currentShellDestination(
        after([{ type: 'setProjectView', view: 'threads' }])
      )
    ).toBe('threads');
    // Files is a page under Tasks with no row of its own.
    expect(
      currentShellDestination(
        after([{ type: 'setProjectView', view: 'files' }])
      )
    ).toBe('issues');
  });

  test('Settings while open, Runs for its runs page, whatever view is under it', () => {
    const tasks = after([{ type: 'tv/showTasks' }]);
    expect(
      currentShellDestination(after([{ type: 'tv/openSettings' }], tasks))
    ).toBe('settings');
    expect(
      currentShellDestination(
        after([{ type: 'tv/openSettings', page: 'a2a' }], tasks)
      )
    ).toBe('settings');
    expect(
      currentShellDestination(
        after([{ type: 'setGlobalView', view: 'all-agents' }])
      )
    ).toBe('runs');
    // Closing Settings hands the row back to the view underneath.
    expect(
      currentShellDestination(
        after([{ type: 'tv/openSettings' }, { type: 'escape' }], tasks)
      )
    ).toBe('issues');
  });
});
