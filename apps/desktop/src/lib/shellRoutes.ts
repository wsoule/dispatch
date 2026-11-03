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
  onLivePage,
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
 * Which destination the sidebar marks current. Settings is an overlay place
 * in the main column (the views stay mounted, hidden, beneath it), so while
 * it is open it (or Runs, its page with a row of its own) is the place. The
 * Live page reads as Runs › Live (it opens from the Runs page and closes back
 * to it), so it marks Runs too. Under Tasks the Docs, Threads, Timeline and
 * Graph pages are their own rows, the Needs you preset is its row, and
 * everything else (the list, a task page, Files, Terminals, Projects) is
 * Issues.
 */
export function currentShellDestination(state: NavState): ShellDestination {
  if (state.settings !== null) {
    return state.settings === 'runs' ? 'runs' : 'settings';
  }
  if (state.mainView === 'overseer') return 'overseer';
  if (onLivePage(state)) return 'runs';
  const page = state.tasksPage;
  if (page.kind === 'docs') return 'docs';
  if (page.kind === 'view' && hasOwnRow(page.view)) return page.view;
  return state.tasksPreset === 'needs-you' ? 'needs-you' : 'issues';
}

/**
 * The topbar's last crumb under the current destination: the open task's
 * title on a task page, "Live" on the Live page, and the page's own name on
 * Files, Terminals and Projects, which keep the Issues row current. So the
 * trail reads project / Runs / Live or project / Issues / Files, with the
 * destination a link back and the page the current one (the topbar marks its
 * last crumb current, so it must never be "Issues" on another page). Null
 * when the destination itself is the page.
 */
export function currentShellPageTitle(
  state: NavState,
  taskTitle: string | null
): string | null {
  if (state.settings !== null) return null;
  if (onLivePage(state)) return LIVE_PAGE_TITLE;
  const page = state.tasksPage;
  if (state.mainView === 'tasks' && page.kind === 'view') {
    return UNLISTED_PAGE_TITLES[page.view] ?? taskTitle;
  }
  return taskTitle;
}

/** The Live page's name: its h1 and its crumb under Runs. */
export const LIVE_PAGE_TITLE = 'Live';

/** The hosted pages under Issues with no sidebar row of their own, by the
 * name their heading and their crumb share. */
const UNLISTED_PAGE_TITLES: Partial<Record<HostedView, string>> = {
  files: 'Files',
  terminals: 'Terminals',
  projects: 'Projects',
};

/** Whether a hosted page is one of the sidebar's rows (Threads, Timeline,
 * Graph), rather than a page reached another way (Files, Terminals, Projects),
 * which keeps the Issues row current. Live, the other hosted page without a
 * row, marks Runs before this is asked. */
function hasOwnRow(
  view: HostedView
): view is Extract<HostedView, ShellDestination> {
  return view === 'threads' || view === 'timeline' || view === 'graph';
}
