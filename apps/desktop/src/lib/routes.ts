import { graphHref, parseGraphParams } from '../adapters/graphScope';
import {
  NAV_SETTINGS_PAGES,
  type NavAction,
  type NavSettingsPage,
  type NavState,
  RETIRED_SETTINGS_PAGES,
  TASK_TABS,
  type TaskTab,
} from './appNav';
import { TASKS_PRESETS, type TasksPreset } from './tasksPresets';

// The app's hash routes: every place the nav reducer can be in, written as a
// `#/…` href and read back as the actions that reach it. One table holds both
// directions, so a link anywhere in the app (the sidebar, a graph crumb, a
// preset tab, a project row) is a real href the browser can open, copy or
// middle-click, and `hooks/useHashRoute.ts` can mirror the state into
// `location.hash` and apply a hash on reload. Pure: no React, no DOM.
//
// Only places are routed. A peek is a drawer over a place and Settings an
// overlay place that takes the main column over it, so neither is in the
// URL, with two exceptions that are destinations in their own right:
// `#/threads?message=` opens Threads with that thread's peek, and
// `#/settings/<page>` opens Settings on a page, since the sidebar has a row
// for it (an old `#/settings/runs` lands on the Runs page, `#/runs`).
//
// Across a reload the hash is the whole memory, so a place that sits over
// another carries the one beneath in a parameter, written as that place's
// own href without its `#/`: the Overseer names where Tasks was left (its
// page, and on the list also its preset, project and layout, as in
// `#/overseer?tasks=` plus `issues?preset=mine` URI-encoded; a task page
// keeps only the page, `#/overseer?tasks=task%2Ft-1`), and Settings names
// the place under it (`#/settings/team?under=timeline`, which may itself be
// the Overseer with its `?tasks=`). Each is left out when it is what a
// reload lands on anyway (Tasks on its bare list; the Overseer), so
// the common hrefs stay `#/overseer` and `#/settings/<page>`, and the
// sidebar's links, which name no parameter, open the top place over whatever
// shows. The list's routed project (`#/issues?project=<id>`, the Projects
// register's Issues link) is a parameter of the list like its preset.

export { graphHref } from '../adapters/graphScope';

/** A task's full page. */
export function taskHref(taskId: string): string {
  return `#/task/${encodeURIComponent(taskId)}`;
}

/** The Timeline opened on one project's lane (brought into view and marked). */
export function timelineHref(projectId: string): string {
  return `#/timeline?project=${encodeURIComponent(projectId)}`;
}

/** The Projects page (the projects register: every open project with its
 * status, next milestone and lead, grouped by initiative), opened from the
 * sidebar's Projects "All". */
export const PROJECTS_HREF = '#/projects';

/** The Issues list narrowed to one preset, and to one container's issues
 * when `project` names it (a project's task id); All with no project is the
 * bare list. Needs you keeps the sidebar's own href. */
export function issuesHref(
  preset: TasksPreset,
  project: string | null = null
): string {
  if (preset === 'needs-you') return href('needs-you', [], { project });
  return href('issues', [], {
    preset: preset === 'all' ? null : preset,
    project,
  });
}

/** One doc, scrolled to `anchor`'s section when set. */
export function docHref(docId: string, anchor: string | null = null): string {
  const base = `#/docs/${encodeURIComponent(docId)}`;
  return anchor === null
    ? base
    : `${base}?anchor=${encodeURIComponent(anchor)}`;
}

/** Settings open on one page; Runs is a page of its own (`#/runs`). */
export function settingsHref(page: NavSettingsPage): string {
  return page === 'runs' ? '#/runs' : `#/settings/${encodeURIComponent(page)}`;
}

/** One route: the hash's first path segment, how a state writes it, and how
 * a hash under it reads back. */
interface Route {
  head: string;
  /** The href for a state this route stands for, or null when it is not
   * where the state is. */
  write(state: NavState): string | null;
  /** The actions a hash under this head means, or null when it is malformed
   * (an extra segment, a value that is not one of the type's). */
  read(rest: readonly string[], params: URLSearchParams): NavAction[] | null;
}

/** `#/head/seg/seg?key=value&key=value`, every segment and value encoded;
 * a null value leaves its key out. */
function href(
  head: string,
  segments: readonly string[] = [],
  params: Readonly<Record<string, string | null>> = {}
): string {
  const path = [head, ...segments].map(encodeURIComponent).join('/');
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return query === '' ? `#/${path}` : `#/${path}?${query}`;
}

function isTaskTab(value: string): value is TaskTab {
  return (TASK_TABS as readonly string[]).includes(value);
}

function isTasksPreset(value: string): value is TasksPreset {
  return TASKS_PRESETS.some((preset) => preset.id === value);
}

function isSettingsPage(value: string): value is NavSettingsPage {
  return (NAV_SETTINGS_PAGES as readonly string[]).includes(value);
}

/** The list's `?preset=`, `?project=` and `?mode=` as actions, after the
 * `showTasks` that opens it; null when one names a value that does not exist
 * (an empty project included). */
function listParams(
  params: URLSearchParams,
  preset: TasksPreset | undefined
): NavAction[] | null {
  const show: NavAction = { type: 'showTasks' };
  if (preset !== undefined) show.preset = preset;
  const project = params.get('project');
  if (project !== null) {
    if (project === '') return null;
    show.project = project;
  }
  const actions: NavAction[] = [show];
  const mode = params.get('mode');
  if (mode !== null) {
    if (mode !== 'list' && mode !== 'board') return null;
    actions.push({ type: 'setTasksMode', mode });
  }
  return actions;
}

/** A route for a hosted view with no parameters (`#/terminals`). */
function pageRoute(
  head: string,
  view: 'terminals' | 'projects' | 'runs' | 'live' | 'week' | 'landing'
): Route {
  return {
    head,
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'view' &&
      state.tasksPage.view === view
        ? href(head)
        : null,
    read: (rest) =>
      rest.length === 0 ? [{ type: 'setProjectView', view }] : null,
  };
}

/** Where a reload lands Tasks when the Overseer's href names no `?tasks=`. */
const BARE_LIST = '#/issues';
/** Where a reload lands under Settings when its href names no `?under=`. */
const BARE_OVERSEER = '#/overseer';

/** The heads that cannot be the place under Settings: Settings itself. */
const NOT_UNDER_SETTINGS: ReadonlySet<string> = new Set(['settings']);
/** The heads that cannot be Tasks' side of the Overseer: anything not Tasks. */
const NOT_UNDER_OVERSEER: ReadonlySet<string> = new Set([
  'overseer',
  'settings',
]);

/** A place written into another route's parameter (the Overseer's `?tasks=`,
 * Settings' `?under=`): its href without the leading `#/`, or null (the key
 * left out) when it is `fallback`, the place a reload lands on without it. */
function nestedPlace(place: NavState, fallback: string): string | null {
  const inner = hrefForState(place);
  return inner === fallback ? null : inner.slice(2);
}

/** The actions of the place a route's parameter names, to apply before the
 * route's own: none when the parameter is absent, null when its value is not
 * a route or is one of `refused`'s heads (a place that cannot sit there). */
function nestedActions(
  value: string | null,
  refused: ReadonlySet<string>
): NavAction[] | null {
  if (value === null) return [];
  const route = parseRoute(`#/${value}`);
  return route === null || refused.has(route.head) ? null : route.actions;
}

/** `open` (Settings on a page), after the actions of the place its
 * `?under=` names. */
function settingsActions(
  params: URLSearchParams,
  open: NavAction
): NavAction[] | null {
  const under = nestedActions(params.get('under'), NOT_UNDER_SETTINGS);
  return under === null ? null : [...under, open];
}

/** The `?under=` parameter of a Settings href: the place below it. */
function underParam(state: NavState): Record<string, string | null> {
  return { under: nestedPlace({ ...state, settings: null }, BARE_OVERSEER) };
}

// In write order: Settings takes the main column over the views, so while
// it is open it is the place; then the Overseer; then Tasks' list and each
// page under it.
const ROUTES: readonly Route[] = [
  {
    head: 'settings',
    write: (state) =>
      state.settings === null
        ? null
        : href('settings', [state.settings], underParam(state)),
    read: (rest, params) => {
      if (rest.length === 0) {
        return settingsActions(params, { type: 'openSettings' });
      }
      if (rest.length !== 1 || rest[0] === undefined) return null;
      const page = RETIRED_SETTINGS_PAGES[rest[0]] ?? rest[0];
      return isSettingsPage(page)
        ? settingsActions(params, { type: 'openSettings', page })
        : null;
    },
  },
  {
    head: 'overseer',
    // Tasks' side is written without its peek: a thread peek opened over the
    // Overseer belongs to the Overseer, which routes none.
    write: (state) =>
      state.mainView === 'overseer'
        ? href('overseer', [], {
            tasks: nestedPlace(
              { ...state, mainView: 'tasks', peek: null },
              BARE_LIST
            ),
          })
        : null,
    read: (rest, params) => {
      if (rest.length !== 0) return null;
      const tasks = nestedActions(params.get('tasks'), NOT_UNDER_OVERSEER);
      return tasks === null ? null : [...tasks, { type: 'showOverseer' }];
    },
  },
  {
    head: 'needs-you',
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'list' &&
      state.tasksPreset === 'needs-you'
        ? href('needs-you', [], {
            project: state.tasksProject,
            mode: state.tasksMode === 'list' ? null : state.tasksMode,
          })
        : null,
    read: (rest, params) =>
      rest.length === 0 ? listParams(params, 'needs-you') : null,
  },
  {
    head: 'issues',
    write: (state) =>
      state.mainView === 'tasks' && state.tasksPage.kind === 'list'
        ? href('issues', [], {
            preset: state.tasksPreset === 'all' ? null : state.tasksPreset,
            project: state.tasksProject,
            mode: state.tasksMode === 'list' ? null : state.tasksMode,
          })
        : null,
    read: (rest, params) => {
      if (rest.length !== 0) return null;
      const preset = params.get('preset');
      if (preset === null) return listParams(params, undefined);
      return isTasksPreset(preset) ? listParams(params, preset) : null;
    },
  },
  {
    head: 'task',
    write: (state) =>
      state.mainView === 'tasks' && state.tasksPage.kind === 'task'
        ? href('task', [state.tasksPage.taskId], {
            tab: state.tasksPage.tab === 'auto' ? null : state.tasksPage.tab,
            run: state.tasksPage.runId,
          })
        : null,
    read: (rest, params) => {
      const [taskId] = rest;
      if (rest.length !== 1 || taskId === undefined) return null;
      const action: NavAction = { type: 'openTask', taskId };
      const tab = params.get('tab');
      if (tab !== null) {
        if (!isTaskTab(tab)) return null;
        action.tab = tab;
      }
      const run = params.get('run');
      if (run !== null) action.runId = run;
      return [action];
    },
  },
  {
    head: 'docs',
    write: (state) => {
      if (state.mainView !== 'tasks' || state.tasksPage.kind !== 'docs') {
        return null;
      }
      const { docId, anchor, merge } = state.tasksPage;
      return docId === null
        ? href('docs')
        : href('docs', [docId], { anchor, merge });
    },
    read: (rest, params) => {
      if (rest.length === 0) return [{ type: 'setProjectView', view: 'docs' }];
      const [docId] = rest;
      if (rest.length !== 1 || docId === undefined) return null;
      const merge = params.get('merge');
      const action: NavAction = {
        type: 'openDoc',
        docId,
        anchor: params.get('anchor'),
      };
      if (merge !== null) action.merge = merge;
      return [action];
    },
  },
  {
    head: 'pr',
    write: (state) =>
      state.mainView === 'tasks' && state.tasksPage.kind === 'pr'
        ? href('pr', [String(state.tasksPage.number)])
        : null,
    read: (rest) => {
      const [number] = rest;
      if (rest.length !== 1 || number === undefined) return null;
      return /^[1-9]\d*$/.test(number)
        ? [{ type: 'openPr', number: Number(number) }]
        : null;
    },
  },
  {
    head: 'draft',
    write: (state) =>
      state.mainView === 'tasks' && state.tasksPage.kind === 'draft'
        ? href('draft', [state.tasksPage.draftId])
        : null,
    read: (rest) => {
      const [draftId] = rest;
      return rest.length === 1 && draftId !== undefined
        ? [{ type: 'openDraft', draftId }]
        : null;
    },
  },
  {
    head: 'room',
    write: (state) =>
      state.mainView === 'tasks' && state.tasksPage.kind === 'room'
        ? href('room', [state.tasksPage.room])
        : null,
    read: (rest) => {
      const [room] = rest;
      return rest.length === 1 && room !== undefined
        ? [{ type: 'openAddress', address: `channel:${room}` }]
        : null;
    },
  },
  {
    head: 'files',
    write: (state) => {
      if (state.mainView !== 'tasks') return null;
      const page = state.tasksPage;
      if (page.kind === 'file') return href('files', [], { path: page.path });
      return page.kind === 'view' && page.view === 'files'
        ? href('files')
        : null;
    },
    read: (rest, params) => {
      if (rest.length !== 0) return null;
      const path = params.get('path');
      return path === null
        ? [{ type: 'setProjectView', view: 'files' }]
        : [{ type: 'openFile', path }];
    },
  },
  pageRoute('terminals', 'terminals'),
  pageRoute('projects', 'projects'),
  pageRoute('runs', 'runs'),
  // The retired Allocation page: its action is on Projects now.
  {
    head: 'allocation',
    write: () => null,
    read: (rest) =>
      rest.length === 0 ? [{ type: 'setProjectView', view: 'projects' }] : null,
  },
  pageRoute('week', 'week'),
  pageRoute('live', 'live'),
  pageRoute('landing', 'landing'),
  {
    head: 'threads',
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'view' &&
      state.tasksPage.view === 'threads'
        ? href('threads', [], {
            message:
              state.peek?.kind === 'thread' ? state.peek.messageId : null,
          })
        : null,
    read: (rest, params) => {
      if (rest.length !== 0) return null;
      const actions: NavAction[] = [
        { type: 'setProjectView', view: 'threads' },
      ];
      const message = params.get('message');
      if (message !== null) {
        actions.push({ type: 'openThread', messageId: message });
      }
      return actions;
    },
  },
  {
    head: 'timeline',
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'view' &&
      state.tasksPage.view === 'timeline'
        ? href('timeline', [], { project: state.tasksPage.project })
        : null,
    read: (rest, params) =>
      rest.length === 0
        ? [{ type: 'openTimeline', project: params.get('project') }]
        : null,
  },
  {
    head: 'graph',
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'view' &&
      state.tasksPage.view === 'graph'
        ? graphHref(state.tasksPage.scope, { node: state.tasksPage.nodeId })
        : null,
    read: (rest, params) => {
      if (rest.length !== 0) return null;
      // The planner's vocabulary (adapters/graphScope): the first value of a
      // repeated parameter counts, and a level the container does not offer
      // falls back to its default rather than failing.
      const record: Record<string, string> = {};
      for (const [key, value] of params) {
        if (!(key in record)) record[key] = value;
      }
      const { scope, nodeId } = parseGraphParams(record);
      return [{ type: 'openGraph', scope, nodeId }];
    },
  },
];

const ROUTE_BY_HEAD = new Map(ROUTES.map((route) => [route.head, route]));

/** The href of the place a state is in. Every state has one: the table's
 * write order ends on the list, which is where Tasks shows nothing else. */
export function hrefForState(state: NavState): string {
  for (const route of ROUTES) {
    const out = route.write(state);
    if (out !== null) return out;
  }
  // Unreachable while the table covers TasksPage; the list is the safe place.
  return href('issues');
}

/**
 * The actions a hash href leads to, or null for anything that is not a route:
 * another anchor (`#main`), a path outside the table, a trailing slash, an
 * extra segment, an id that fails to decode, or a parameter naming a value
 * that does not exist (`?preset=bogus`, a `?tasks=` or `?under=` that is not
 * a place that can sit there). Parameters the route does not read are
 * ignored. Applied in order to the reducer, the actions land on the place.
 */
export function parseHref(href: string): NavAction[] | null {
  return parseRoute(href)?.actions ?? null;
}

/** `parseHref`, keeping the route's head, which a nested place is checked
 * against (`nestedActions`). */
function parseRoute(
  href: string
): { head: string; actions: NavAction[] } | null {
  if (!href.startsWith('#/')) return null;
  const at = href.indexOf('?');
  const path = at === -1 ? href.slice(2) : href.slice(2, at);
  const query = at === -1 ? '' : href.slice(at + 1);
  if (path === '') return null;
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') return null;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  const [head, ...rest] = segments;
  if (head === undefined) return null;
  const route = ROUTE_BY_HEAD.get(head);
  if (route === undefined) return null;
  const actions = route.read(rest, new URLSearchParams(query));
  return actions === null ? null : { head, actions };
}
