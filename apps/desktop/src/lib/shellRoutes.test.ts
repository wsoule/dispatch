import { describe, expect, test } from 'bun:test';

import {
  initialNavState,
  type NavAction,
  navReducer,
  type NavState,
} from './appNav';
import { parseHref } from './routes';
import {
  currentShellDestination,
  hrefFor,
  MOD_KEY,
  PROJECTS_HREF,
  SHELL_ROUTES,
  type ShellDestination,
  shellRoute,
  shellShortcut,
  taskHref,
  timelineHref,
} from './shellRoutes';

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
  actions: NavAction[],
  from: NavState = initialNavState
): NavState {
  return actions.reduce(navReducer, from);
}

describe('the route table', () => {
  test('lists every destination once, each at its own hash', () => {
    expect(SHELL_ROUTES.map((route) => route.id)).toEqual([
      ...EVERY_DESTINATION,
    ]);
    for (const id of EVERY_DESTINATION) {
      expect(shellRoute(id).href).toBe(`#/${id}`);
      expect(hrefFor(id)).toBe(`#/${id}`);
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
    expect(shellRoute('overseer').action).toEqual({ type: 'showOverseer' });
    expect(shellRoute('issues').action).toEqual({ type: 'showTasks' });
    expect(shellRoute('needs-you').action).toEqual({
      type: 'showTasks',
      preset: 'needs-you',
    });
    expect(shellRoute('threads').action).toEqual({
      type: 'setProjectView',
      view: 'threads',
    });
    expect(shellRoute('timeline').action).toEqual({
      type: 'openTimeline',
      project: null,
    });
    expect(shellRoute('graph').action).toEqual({
      type: 'openGraph',
      scope: { level: 'milestone' },
      nodeId: null,
    });
    expect(shellRoute('docs').action).toEqual({
      type: 'setProjectView',
      view: 'docs',
    });
    expect(shellRoute('runs').action).toEqual({
      type: 'openSettings',
      page: 'runs',
    });
    expect(shellRoute('settings').action).toEqual({ type: 'openSettings' });
  });

  test('each action is exactly what its href parses to', () => {
    for (const route of SHELL_ROUTES) {
      expect(parseHref(route.href)).toEqual([route.action]);
    }
  });

  test('re-exports the hrefs the shell adapters link with', () => {
    expect(taskHref('t-9b2d14')).toBe('#/task/t-9b2d14');
    expect(timelineHref('p-1')).toBe('#/timeline?project=p-1');
    expect(PROJECTS_HREF).toBe('#/projects');
  });
});

describe('currentShellDestination', () => {
  test('the app opens on Overseer', () => {
    expect(currentShellDestination(initialNavState)).toBe('overseer');
  });

  test('the Tasks list is Issues under any preset but Needs you', () => {
    const tasks = after([{ type: 'showTasks' }]);
    expect(currentShellDestination(tasks)).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'setTasksPreset', preset: 'failed' }], tasks)
      )
    ).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'showTasks', preset: 'needs-you' }])
      )
    ).toBe('needs-you');
  });

  test('a task quick-looked over the list, or open as its page, keeps the list row current', () => {
    const peeked = after([
      { type: 'showTasks' },
      { type: 'openPeek', taskId: 't-1' },
    ]);
    expect(peeked.peek).toEqual({ kind: 'task', taskId: 't-1' });
    expect(currentShellDestination(peeked)).toBe('issues');
    const open = after([
      { type: 'showTasks' },
      { type: 'openTask', taskId: 't-1' },
    ]);
    expect(open.tasksPage.kind).toBe('task');
    expect(currentShellDestination(open)).toBe('issues');
    expect(
      currentShellDestination(
        after([{ type: 'setTasksPreset', preset: 'needs-you' }], open)
      )
    ).toBe('needs-you');
  });

  test('the timeline page is its own row, focused on a lane or not', () => {
    const timeline = after([{ type: 'openTimeline', project: null }]);
    expect(timeline.tasksPage).toEqual({
      kind: 'view',
      view: 'timeline',
      project: null,
    });
    expect(currentShellDestination(timeline)).toBe('timeline');
    expect(
      currentShellDestination(after([{ type: 'openTimeline', project: 'p-1' }]))
    ).toBe('timeline');
    // A milestone quick-looked over the chart keeps the row.
    expect(
      currentShellDestination(
        after([{ type: 'openPeek', taskId: 'm-1' }], timeline)
      )
    ).toBe('timeline');
    expect(
      currentShellDestination(after([{ type: 'closePage' }], timeline))
    ).toBe('issues');
  });

  test('the graph page is its own row at any scope', () => {
    const graph = after([{ type: 'setProjectView', view: 'graph' }]);
    expect(graph.tasksPage).toMatchObject({ kind: 'view', view: 'graph' });
    expect(currentShellDestination(graph)).toBe('graph');
    expect(
      currentShellDestination(
        after([
          {
            type: 'openGraph',
            scope: { level: 'issue', milestoneId: 'ms-1' },
            nodeId: 't-1',
          },
        ])
      )
    ).toBe('graph');
    // A node quick-looked over the chart keeps the row.
    expect(
      currentShellDestination(
        after([{ type: 'openPeek', taskId: 'p-1' }], graph)
      )
    ).toBe('graph');
    expect(currentShellDestination(after([{ type: 'closePage' }], graph))).toBe(
      'issues'
    );
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
    const tasks = after([{ type: 'showTasks' }]);
    expect(
      currentShellDestination(after([{ type: 'openSettings' }], tasks))
    ).toBe('settings');
    expect(
      currentShellDestination(
        after([{ type: 'openSettings', page: 'a2a' }], tasks)
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
        after([{ type: 'openSettings' }, { type: 'escape' }], tasks)
      )
    ).toBe('issues');
  });
});
