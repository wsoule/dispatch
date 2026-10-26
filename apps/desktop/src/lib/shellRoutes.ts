import type { ShellIcon } from '@dispatch/ui';
import {
  BookText,
  Bot,
  CalendarRange,
  History,
  Inbox,
  ListTodo,
  MessagesSquare,
  Network,
  Settings,
} from 'lucide-react';

import {
  DEFAULT_GRAPH_SCOPE,
  type HostedView,
  type NavAction,
  type NavState,
} from './appNav';

// The shell's top-level destinations: what the sidebar lists, the hash href
// that stands for each (a real route, see lib/routes.ts) and the action a
// plain click dispatches, which is what `parseHref(href)` reads back
// (shellRoutes.test.ts holds the two together). The hrefs are real: a
// middle-click or a copied link opens the same place, and `useHashRoute`
// mirrors the place into `location.hash`.

export { PROJECTS_HREF, taskHref, timelineHref } from './routes';

export type ShellDestination =
  | 'overseer'
  | 'issues'
  | 'needs-you'
  | 'timeline'
  | 'graph'
  | 'threads'
  | 'docs'
  | 'runs'
  | 'settings';

/** The modifier key as a display token; the shell swaps in ⌘ or Ctrl. */
export const MOD_KEY = 'Mod';

export interface ShellRoute {
  id: ShellDestination;
  label: string;
  icon: ShellIcon;
  /** Display-only keys: `MOD_KEY` then a digit, or a G chord's two letters. */
  shortcut?: readonly string[];
  href: string;
  /** What selecting it dispatches: `parseHref(href)`'s one action. */
  action: NavAction;
}

export function hrefFor(id: ShellDestination): string {
  return `#/${id}`;
}

/** Every destination in sidebar order; Settings is drawn in the footer. */
export const SHELL_ROUTES: readonly ShellRoute[] = [
  {
    id: 'overseer',
    label: 'Overseer',
    icon: Bot,
    shortcut: [MOD_KEY, '1'],
    href: hrefFor('overseer'),
    action: { type: 'showOverseer' },
  },
  {
    id: 'issues',
    label: 'Issues',
    icon: ListTodo,
    shortcut: [MOD_KEY, '2'],
    href: hrefFor('issues'),
    action: { type: 'showTasks' },
  },
  {
    id: 'needs-you',
    label: 'Needs you',
    icon: Inbox,
    shortcut: ['G', 'I'],
    href: hrefFor('needs-you'),
    action: { type: 'showTasks', preset: 'needs-you' },
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: CalendarRange,
    // `g t` is Tasks, so the timeline takes the L of its last syllable.
    shortcut: ['G', 'L'],
    href: hrefFor('timeline'),
    action: { type: 'openTimeline', project: null },
  },
  {
    id: 'graph',
    label: 'Graph',
    icon: Network,
    // The one chord letter the Graph owns outright; a second `g` completes the
    // chord rather than re-arming it (lib/keyboard.ts).
    shortcut: ['G', 'G'],
    href: hrefFor('graph'),
    action: { type: 'openGraph', scope: DEFAULT_GRAPH_SCOPE, nodeId: null },
  },
  {
    id: 'threads',
    label: 'Threads',
    icon: MessagesSquare,
    shortcut: ['G', 'M'],
    href: hrefFor('threads'),
    action: { type: 'setProjectView', view: 'threads' },
  },
  {
    id: 'docs',
    label: 'Docs',
    icon: BookText,
    href: hrefFor('docs'),
    action: { type: 'setProjectView', view: 'docs' },
  },
  {
    id: 'runs',
    label: 'Runs',
    icon: History,
    href: hrefFor('runs'),
    action: { type: 'openSettings', page: 'runs' },
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    shortcut: ['G', 'S'],
    href: hrefFor('settings'),
    action: { type: 'openSettings' },
  },
];

const ROUTE_BY_ID = new Map(SHELL_ROUTES.map((route) => [route.id, route]));

export function shellRoute(id: ShellDestination): ShellRoute {
  const route = ROUTE_BY_ID.get(id);
  if (route === undefined) throw new Error(`unknown shell destination ${id}`);
  return route;
}

/** The keys as the shell prints them, with the platform's modifier label. */
export function shellShortcut(
  route: ShellRoute,
  modLabel: string
): string[] | undefined {
  return route.shortcut?.map((key) => (key === MOD_KEY ? modLabel : key));
}

/**
 * Which destination the sidebar marks current. Settings is a dialog over the
 * views, so while it is open it (or Runs, its page with a row of its own) is
 * the place; under Tasks the Docs, Threads, Timeline and Graph pages are their
 * own rows, the Needs you preset is its row, and everything else (the list, a
 * task page, Files, Terminals, Projects, Live) is Issues.
 */
export function currentShellDestination(state: NavState): ShellDestination {
  if (state.settings !== null) {
    return state.settings === 'runs' ? 'runs' : 'settings';
  }
  if (state.mainView === 'overseer') return 'overseer';
  const page = state.tasksPage;
  if (page.kind === 'docs') return 'docs';
  if (page.kind === 'view' && hasOwnRow(page.view)) return page.view;
  return state.tasksPreset === 'needs-you' ? 'needs-you' : 'issues';
}

/** Whether a hosted page is one of the sidebar's rows (Threads, Timeline,
 * Graph), rather than a page reached another way (Files, Terminals, Projects,
 * Live), which keeps the Issues row current. */
function hasOwnRow(
  view: HostedView
): view is Extract<HostedView, ShellDestination> {
  return view === 'threads' || view === 'timeline' || view === 'graph';
}
