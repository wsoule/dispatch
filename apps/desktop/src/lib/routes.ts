import { graphHref, parseGraphParams } from '../adapters/graphScope';
import {
  NAV_SETTINGS_PAGES,
  type NavAction,
  type NavSettingsPage,
  type NavState,
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
// Only places are routed. A peek is a drawer over a place and Settings a
// dialog over it, so neither is in the URL, with two exceptions that are
// destinations in their own right: `#/threads?message=` opens Threads with
// that thread's peek, and `#/settings/<page>` (or `#/runs`) opens Settings on
// a page, since the sidebar has rows for both. Only the top place is routed,
// too: on the Overseer the hash is `#/overseer` whatever Tasks page, preset
// or layout the reducer would return to, and `#/settings/<page>` says nothing
// about the view beneath, so a reload there lands Tasks on its list. Within a
// session the reducer keeps all of it; across a reload the hash is the whole
// memory, by design (one place, one href).

export { graphHref } from '../adapters/graphScope';

/** A task's full page. */
export function taskHref(taskId: string): string {
  return `#/task/${encodeURIComponent(taskId)}`;
}

/** The Timeline opened on one project's lane (brought into view and marked). */
export function timelineHref(projectId: string): string {
  return `#/timeline?project=${encodeURIComponent(projectId)}`;
}

/** The Projects page under Tasks (the projects register: every open project
 * with its status, next milestone, lead and allocation, grouped by
 * initiative), which has no sidebar row. */
export const PROJECTS_HREF = '#/projects';

/** The Issues list narrowed to one preset; All is the bare list. Needs you
 * keeps the sidebar's own href. */
export function issuesHref(preset: TasksPreset): string {
  if (preset === 'all') return '#/issues';
  if (preset === 'needs-you') return '#/needs-you';
  return `#/issues?preset=${encodeURIComponent(preset)}`;
}

/** One doc, scrolled to `anchor`'s section when set. */
export function docHref(docId: string, anchor: string | null = null): string {
  const base = `#/docs/${encodeURIComponent(docId)}`;
  return anchor === null
    ? base
    : `${base}?anchor=${encodeURIComponent(anchor)}`;
}

/** Settings open on one page; the Runs page keeps the sidebar's own href. */
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

/** The list's `?preset=` and `?mode=` as actions, after the `showTasks` that
 * opens it; null when either names a value that does not exist. */
function listParams(
  params: URLSearchParams,
  preset: TasksPreset | undefined
): NavAction[] | null {
  const actions: NavAction[] =
    preset === undefined
      ? [{ type: 'showTasks' }]
      : [{ type: 'showTasks', preset }];
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
  view: 'terminals' | 'projects' | 'live'
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

// In write order: Settings is a dialog over the views, so while it is open
// it (or Runs, its page with a row of its own) is the place; then the
// Overseer; then Tasks' list and each page under it.
const ROUTES: readonly Route[] = [
  {
    head: 'runs',
    write: (state) => (state.settings === 'runs' ? href('runs') : null),
    read: (rest) =>
      rest.length === 0 ? [{ type: 'openSettings', page: 'runs' }] : null,
  },
  {
    head: 'settings',
    write: (state) =>
      state.settings === null ? null : href('settings', [state.settings]),
    read: (rest) => {
      if (rest.length === 0) return [{ type: 'openSettings' }];
      const [page] = rest;
      return rest.length === 1 && page !== undefined && isSettingsPage(page)
        ? [{ type: 'openSettings', page }]
        : null;
    },
  },
  {
    head: 'overseer',
    write: (state) => (state.mainView === 'overseer' ? href('overseer') : null),
    read: (rest) => (rest.length === 0 ? [{ type: 'showOverseer' }] : null),
  },
  {
    head: 'needs-you',
    write: (state) =>
      state.mainView === 'tasks' &&
      state.tasksPage.kind === 'list' &&
      state.tasksPreset === 'needs-you'
        ? href('needs-you', [], {
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
  pageRoute('live', 'live'),
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
 * that does not exist (`?preset=bogus`). Parameters the route does not read
 * are ignored. Applied in order to the reducer, the actions land on the place.
 */
export function parseHref(href: string): NavAction[] | null {
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
  return route.read(rest, new URLSearchParams(query));
}
