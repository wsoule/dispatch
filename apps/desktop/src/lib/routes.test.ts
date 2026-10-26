import { describe, expect, test } from 'bun:test';

import {
  initialNavState,
  type NavAction,
  navReducer,
  type NavState,
} from './appNav';
import {
  docHref,
  graphHref,
  hrefForState,
  issuesHref,
  parseHref,
  PROJECTS_HREF,
  settingsHref,
  taskHref,
  timelineHref,
} from './routes';
import { SHELL_ROUTES } from './shellRoutes';

// A project is active, as it is whenever a route is applied (useHashRoute
// waits for one): the state every table below starts from.
const PROJECT: NavState = navReducer(initialNavState, {
  type: 'selectProject',
  projectId: '/repo',
});

function run(actions: readonly NavAction[], from: NavState = PROJECT) {
  return actions.reduce(navReducer, from);
}

/** The state a route lands on from a fresh project, or null for no route. */
function land(href: string): NavState | null {
  const actions = parseHref(href);
  return actions === null ? null : run(actions);
}

describe('hrefForState ↔ parseHref', () => {
  // Every place the reducer can be in, as the actions that reach it and the
  // href that stands for it. Applying the href's actions to a fresh project
  // lands on a state with the same href.
  const places: [string, NavAction[]][] = [
    ['#/overseer', []],
    ['#/overseer', [{ type: 'showOverseer' }]],
    ['#/issues', [{ type: 'showTasks' }]],
    ['#/issues?preset=failed', [{ type: 'showTasks', preset: 'failed' }]],
    ['#/needs-you', [{ type: 'showTasks', preset: 'needs-you' }]],
    [
      '#/needs-you?mode=board',
      [
        { type: 'showTasks', preset: 'needs-you' },
        { type: 'setTasksMode', mode: 'board' },
      ],
    ],
    [
      '#/issues?preset=mine&mode=board',
      [
        { type: 'showTasks', preset: 'mine' },
        { type: 'setTasksMode', mode: 'board' },
      ],
    ],
    [
      '#/issues?mode=board',
      [{ type: 'showTasks' }, { type: 'setTasksMode', mode: 'board' }],
    ],
    ['#/timeline', [{ type: 'openTimeline', project: null }]],
    ['#/timeline?project=p-1', [{ type: 'openTimeline', project: 'p-1' }]],
    ['#/graph', [{ type: 'setProjectView', view: 'graph' }]],
    [
      '#/graph?level=issue',
      [{ type: 'openGraph', scope: { level: 'issue' }, nodeId: null }],
    ],
    [
      '#/graph?project=p-1&level=milestone&node=ms-1',
      [
        {
          type: 'openGraph',
          scope: { level: 'milestone', projectId: 'p-1' },
          nodeId: 'ms-1',
        },
      ],
    ],
    [
      '#/graph?chain=ENG-24',
      [
        {
          type: 'openGraph',
          scope: { level: 'issue', issueId: 'ENG-24' },
          nodeId: null,
        },
      ],
    ],
    ['#/projects', [{ type: 'setProjectView', view: 'projects' }]],
    ['#/live', [{ type: 'setProjectView', view: 'live' }]],
    ['#/files', [{ type: 'setProjectView', view: 'files' }]],
    ['#/files?path=src%2Fa.ts', [{ type: 'openFile', path: 'src/a.ts' }]],
    ['#/terminals', [{ type: 'setProjectView', view: 'terminals' }]],
    ['#/threads', [{ type: 'setProjectView', view: 'threads' }]],
    [
      '#/threads?message=m-1',
      [
        { type: 'setProjectView', view: 'threads' },
        { type: 'openThread', messageId: 'm-1' },
      ],
    ],
    ['#/docs', [{ type: 'setProjectView', view: 'docs' }]],
    ['#/docs/spec', [{ type: 'openDoc', docId: 'spec', anchor: null }]],
    [
      '#/docs/spec?anchor=api&merge=rev-p',
      [{ type: 'openDoc', docId: 'spec', anchor: 'api', merge: 'rev-p' }],
    ],
    ['#/task/t-1', [{ type: 'openTask', taskId: 't-1' }]],
    [
      '#/task/t-1?tab=review&run=r-9',
      [{ type: 'openTask', taskId: 't-1', tab: 'review', runId: 'r-9' }],
    ],
    ['#/pr/12', [{ type: 'openPr', number: 12 }]],
    ['#/draft/d-1', [{ type: 'openDraft', draftId: 'd-1' }]],
    ['#/room/release', [{ type: 'openAddress', address: 'channel:release' }]],
    ['#/runs', [{ type: 'openSettings', page: 'runs' }]],
    ['#/settings/general', [{ type: 'openSettings' }]],
    ['#/settings/usage', [{ type: 'setGlobalView', view: 'sessions' }]],
    [
      '#/settings/integrations',
      [{ type: 'setGlobalView', view: 'settings', page: 'integrations' }],
    ],
  ];

  test.each(places)('%s', (href, actions) => {
    const state = run(actions);
    expect(hrefForState(state)).toBe(href);
    const landed = land(href);
    expect(landed).not.toBeNull();
    if (landed === null) return;
    expect(hrefForState(landed)).toBe(href);
    expect(landed.mainView).toBe(state.mainView);
    expect(landed.tasksPage).toEqual(state.tasksPage);
    expect(landed.settings).toBe(state.settings);
  });

  test('ids are percent-encoded on the way out and decoded on the way back', () => {
    const id = 'weird id/with:chars&more?';
    expect(taskHref(id)).toBe(`#/task/${encodeURIComponent(id)}`);
    expect(parseHref(taskHref(id))).toEqual([{ type: 'openTask', taskId: id }]);
    expect(parseHref(timelineHref(id))).toEqual([
      { type: 'openTimeline', project: id },
    ]);
    expect(parseHref(docHref(id, 'a b'))).toEqual([
      { type: 'openDoc', docId: id, anchor: 'a b' },
    ]);
    const landed = land(`#/files?path=${encodeURIComponent(id)}`);
    expect(landed?.tasksPage).toEqual({ kind: 'file', path: id });
    expect(hrefForState(run([{ type: 'openFile', path: id }]))).toBe(
      `#/files?path=${encodeURIComponent(id)}`
    );
  });

  test('a peek, Settings and the dialogs are not in the href, except the two with rows', () => {
    const peeked = run([
      { type: 'showTasks' },
      { type: 'openPeek', taskId: 't-1' },
    ]);
    expect(hrefForState(peeked)).toBe('#/issues');
    const dialogs = run([
      { type: 'openPalette' },
      { type: 'openNewTask' },
      { type: 'openShortcuts' },
    ]);
    expect(hrefForState(dialogs)).toBe('#/overseer');
    // A thread peek over Overseer is Overseer; over Threads it is the route.
    expect(hrefForState(run([{ type: 'openThread', messageId: 'm-1' }]))).toBe(
      '#/overseer'
    );
    // Settings open is the place, whatever view is under it.
    expect(
      hrefForState(
        run([
          { type: 'openTask', taskId: 't-1' },
          { type: 'openSettings', page: 'team' },
        ])
      )
    ).toBe('#/settings/team');
  });

  test('the sidebar’s hrefs each parse to their row’s action', () => {
    for (const route of SHELL_ROUTES) {
      expect(parseHref(route.href)).toEqual([route.action]);
    }
  });

  test('a route the window opened on leaves the layout and the view it does not name alone', () => {
    const board = run([{ type: 'setTasksMode', mode: 'board' }]);
    const landed = run(parseHref('#/timeline') ?? [], board);
    expect(landed.tasksMode).toBe('board');
    expect(hrefForState(landed)).toBe('#/timeline');
  });
});

describe('parseHref rejects what is not a route', () => {
  test.each([
    '',
    '#',
    '#/',
    '#main',
    '#dispatch-main',
    '/issues',
    'issues',
    '#/issues/',
    '#/issues/extra',
    '#/nowhere',
    '#/task',
    '#/task/',
    '#/task/t-1/more',
    '#/pr/abc',
    '#/pr/0',
    '#/pr/-1',
    '#/draft',
    '#/room',
    '#/docs/a/b',
    '#/settings/nope',
    '#/settings/general/more',
    '#/runs/all',
    '#/timeline/p-1',
    '#/graph/extra',
    '#/issues?preset=bogus',
    '#/issues?mode=grid',
    '#/needs-you?mode=lanes',
    '#/task/t-1?tab=nope',
    '#/task/%E0%A4%A',
    'https://example.com/#/issues',
  ])('%p', (href) => {
    expect(parseHref(href)).toBeNull();
  });

  test('parameters a route does not read are ignored', () => {
    expect(parseHref('#/timeline?lane=p-1')).toEqual([
      { type: 'openTimeline', project: null },
    ]);
    expect(parseHref('#/overseer?x=1')).toEqual([{ type: 'showOverseer' }]);
  });

  test('a graph level the container does not offer falls back, as the planner did', () => {
    expect(parseHref('#/graph?project=p-1&level=initiative')).toEqual([
      {
        type: 'openGraph',
        scope: { level: 'issue', projectId: 'p-1' },
        nodeId: null,
      },
    ]);
    // A repeated parameter keeps its first value.
    expect(parseHref('#/graph?project=p-1&project=p-2')).toEqual([
      {
        type: 'openGraph',
        scope: { level: 'issue', projectId: 'p-1' },
        nodeId: null,
      },
    ]);
  });
});

describe('the href builders', () => {
  test('write the routes the views link with', () => {
    expect(taskHref('t-1')).toBe('#/task/t-1');
    expect(timelineHref('p-1')).toBe('#/timeline?project=p-1');
    expect(PROJECTS_HREF).toBe('#/projects');
    expect(issuesHref('all')).toBe('#/issues');
    expect(issuesHref('needs-you')).toBe('#/needs-you');
    expect(issuesHref('failed')).toBe('#/issues?preset=failed');
    expect(graphHref({ level: 'issue', milestoneId: 'ms-1' })).toBe(
      '#/graph?milestone=ms-1'
    );
    expect(docHref('spec')).toBe('#/docs/spec');
    expect(docHref('spec', 'api')).toBe('#/docs/spec?anchor=api');
    expect(settingsHref('runs')).toBe('#/runs');
    expect(settingsHref('a2a')).toBe('#/settings/a2a');
  });

  test('every builder’s href parses and lands where it says', () => {
    expect(land(issuesHref('failed'))?.tasksPreset).toBe('failed');
    expect(land(issuesHref('needs-you'))?.tasksPreset).toBe('needs-you');
    expect(
      land(graphHref({ level: 'issue', milestoneId: 'ms-1' }))?.tasksPage
    ).toEqual({
      kind: 'view',
      view: 'graph',
      scope: { level: 'issue', milestoneId: 'ms-1' },
      nodeId: null,
    });
    expect(land(docHref('spec', 'api'))?.tasksPage).toEqual({
      kind: 'docs',
      docId: 'spec',
      anchor: 'api',
      merge: null,
    });
    expect(land(settingsHref('a2a'))?.settings).toBe('a2a');
    expect(land(PROJECTS_HREF)?.tasksPage).toEqual({
      kind: 'view',
      view: 'projects',
    });
  });
});
