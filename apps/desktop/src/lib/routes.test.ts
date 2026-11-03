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

/** A place written into another route's parameter, as `hrefForState` encodes
 * it (`?tasks=`, `?under=`). */
const enc = encodeURIComponent;

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
    ['#/issues?project=p-1', [{ type: 'showTasks', project: 'p-1' }]],
    [
      '#/issues?preset=failed&project=p-1&mode=board',
      [
        { type: 'showTasks', preset: 'failed', project: 'p-1' },
        { type: 'setTasksMode', mode: 'board' },
      ],
    ],
    [
      '#/needs-you?project=p-1',
      [{ type: 'showTasks', preset: 'needs-you', project: 'p-1' }],
    ],
    // A place over another carries the one beneath.
    [
      `#/overseer?tasks=${enc('task/t-1')}`,
      [{ type: 'openTask', taskId: 't-1' }, { type: 'showOverseer' }],
    ],
    [
      `#/overseer?tasks=${enc('issues?preset=failed&mode=board')}`,
      [
        { type: 'showTasks', preset: 'failed' },
        { type: 'setTasksMode', mode: 'board' },
        { type: 'showOverseer' },
      ],
    ],
    [
      `#/settings/agents?under=${enc('timeline?project=p-1')}`,
      [
        { type: 'openTimeline', project: 'p-1' },
        { type: 'openSettings', page: 'agents' },
      ],
    ],
    [
      '#/runs?under=live',
      [
        { type: 'setProjectView', view: 'live' },
        { type: 'openSettings', page: 'runs' },
      ],
    ],
    [
      `#/settings/team?under=${enc('overseer?tasks=graph')}`,
      [
        { type: 'setProjectView', view: 'graph' },
        { type: 'showOverseer' },
        { type: 'openSettings', page: 'team' },
      ],
    ],
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
    expect(landed.tasksPreset).toBe(state.tasksPreset);
    expect(landed.tasksProject).toBe(state.tasksProject);
    expect(landed.tasksMode).toBe(state.tasksMode);
  });

  test('a reload on the Overseer or under Settings keeps the Tasks side', () => {
    // Left on the list (narrowed, on the board) or on a task page's Review
    // tab, then the Overseer, then Settings: each href names what the reducer
    // would return to, as much as the Tasks place's own href does.
    const onList = run([
      { type: 'showTasks', preset: 'failed', project: 'p-1' },
      { type: 'setTasksMode', mode: 'board' },
    ]);
    const onTask = run([{ type: 'openTask', taskId: 't-1', tab: 'review' }]);
    for (const left of [onList, onTask]) {
      const overseer = run([{ type: 'showOverseer' }], left);
      const settings = run([{ type: 'openSettings', page: 'team' }], overseer);
      for (const state of [overseer, settings]) {
        const landed = land(hrefForState(state));
        expect(landed).not.toBeNull();
        if (landed === null) return;
        expect(hrefForState(landed)).toBe(hrefForState(state));
        expect(landed.mainView).toBe('overseer');
        expect(landed.settings).toBe(state.settings);
        expect(landed.tasksPage).toEqual(left.tasksPage);
        expect(landed.tasksPreset).toBe(left.tasksPreset);
        expect(landed.tasksProject).toBe(left.tasksProject);
        expect(landed.tasksMode).toBe(left.tasksMode);
        // Back from the Overseer reaches the Tasks place, as before the reload.
        const back = run([{ type: 'closeSettings' }, { type: 'back' }], landed);
        expect(back.mainView).toBe('tasks');
        expect(back.tasksPage).toEqual(left.tasksPage);
      }
    }
    expect(hrefForState(run([{ type: 'showOverseer' }], onList))).toBe(
      `#/overseer?tasks=${enc('issues?preset=failed&project=p-1&mode=board')}`
    );
  });

  test('the place beneath is left out when a reload lands there anyway', () => {
    // Tasks on its bare list under the Overseer; the Overseer under Settings.
    expect(hrefForState(run([{ type: 'showOverseer' }]))).toBe('#/overseer');
    expect(
      hrefForState(
        run([
          { type: 'showTasks' },
          { type: 'showOverseer' },
          { type: 'openSettings', page: 'agents' },
        ])
      )
    ).toBe('#/settings/agents');
    // A thread peek over the Overseer is the Overseer's, not Tasks' side.
    expect(
      hrefForState(
        run([
          { type: 'setProjectView', view: 'threads' },
          { type: 'showOverseer' },
          { type: 'openThread', messageId: 'm-1' },
        ])
      )
    ).toBe('#/overseer?tasks=threads');
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
    // Settings open is the place; the view under it rides in `?under=`, and
    // a task peek beneath it stays out, as it does everywhere.
    expect(
      hrefForState(
        run([
          { type: 'openTask', taskId: 't-1' },
          { type: 'openPeek', taskId: 't-2' },
          { type: 'openSettings', page: 'team' },
        ])
      )
    ).toBe(`#/settings/team?under=${enc('task/t-1')}`);
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
    '#/issues?project=',
    '#/overseer?tasks=',
    '#/overseer?tasks=overseer',
    `#/overseer?tasks=${enc('settings/team')}`,
    '#/overseer?tasks=runs',
    '#/overseer?tasks=nowhere',
    `#/overseer?tasks=${enc('issues?preset=bogus')}`,
    `#/settings/team?under=${enc('settings/general')}`,
    '#/settings/team?under=runs',
    '#/runs?under=settings',
    '#/settings?under=nowhere',
    `#/settings/team?under=${enc('overseer?tasks=overs')}`,
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
    expect(issuesHref('all', 'p-1')).toBe('#/issues?project=p-1');
    expect(issuesHref('needs-you', 'p 1')).toBe('#/needs-you?project=p%201');
    expect(issuesHref('mine', 'p-1')).toBe('#/issues?preset=mine&project=p-1');
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
    expect(land(issuesHref('all', 'p/1'))?.tasksProject).toBe('p/1');
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
