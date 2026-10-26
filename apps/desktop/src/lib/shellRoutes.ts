import type { ShellIcon } from '@dispatch/ui';
import {
  BookText,
  Bot,
  History,
  Inbox,
  ListTodo,
  MessagesSquare,
  Settings,
} from 'lucide-react';

import type { NavAction } from './appNav';
import type { TwoViewsAction, TwoViewsState } from './twoViews';

// The shell's top-level destinations: what the sidebar lists, which Two views
// place each one is, and the hash href that stands for it. The hrefs exist so
// AppShell's links are real (middle-click, copy link) and a later phase can
// grow them into routes; today a plain click dispatches the destination's
// action and the hash never changes.

export type ShellDestination =
  | 'overseer'
  | 'issues'
  | 'needs-you'
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
  /** What selecting it dispatches: the action the old top bar sent. */
  action: NavAction | TwoViewsAction;
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
    action: { type: 'tv/showOverseer' },
  },
  {
    id: 'issues',
    label: 'Issues',
    icon: ListTodo,
    shortcut: [MOD_KEY, '2'],
    href: hrefFor('issues'),
    action: { type: 'tv/showTasks' },
  },
  {
    id: 'needs-you',
    label: 'Needs you',
    icon: Inbox,
    shortcut: ['G', 'I'],
    href: hrefFor('needs-you'),
    action: { type: 'tv/showTasks', preset: 'needs-you' },
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
    action: { type: 'tv/openSettings', page: 'runs' },
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    shortcut: ['G', 'S'],
    href: hrefFor('settings'),
    action: { type: 'tv/openSettings' },
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

const DESTINATION_HREF = /^#\/([a-z-]+)$/;

/** The destination an href stands for, or null for any other link. */
export function parseShellHref(href: string): ShellDestination | null {
  const match = DESTINATION_HREF.exec(href);
  if (match === null) return null;
  const id = match[1] as ShellDestination;
  return ROUTE_BY_ID.has(id) ? id : null;
}

/** A project row's link: the project's own page under Issues. */
export function taskHref(taskId: string): string {
  return `#/task/${encodeURIComponent(taskId)}`;
}

/** The Projects section's "All": the Issues graph layout. */
export const PROJECTS_HREF = '#/projects';

const TASK_HREF = /^#\/task\/([^/]+)$/;

/** What a shell link leads to; null for links the browser should follow itself
 * (the skip link, an external URL). */
export type ShellLinkTarget =
  | { kind: 'destination'; id: ShellDestination }
  | { kind: 'task'; taskId: string }
  | { kind: 'projects' };

export function resolveShellHref(href: string): ShellLinkTarget | null {
  const destination = parseShellHref(href);
  if (destination !== null) return { kind: 'destination', id: destination };
  if (href === PROJECTS_HREF) return { kind: 'projects' };
  const task = TASK_HREF.exec(href);
  if (task !== null) {
    return { kind: 'task', taskId: decodeURIComponent(task[1]) };
  }
  return null;
}

/**
 * Which destination the sidebar marks current. Settings is a dialog over the
 * views, so while it is open it (or Runs, its page with a row of its own) is
 * the place; under Tasks the Docs and Threads pages are their own rows, the
 * Needs you preset is its row, and everything else is Issues.
 */
export function currentShellDestination(
  state: TwoViewsState
): ShellDestination {
  if (state.settings !== null) {
    return state.settings === 'runs' ? 'runs' : 'settings';
  }
  if (state.mainView === 'overseer') return 'overseer';
  const page = state.tasksPage;
  if (page.kind === 'docs') return 'docs';
  if (page.kind === 'view' && page.view === 'threads') return 'threads';
  return state.tasksPreset === 'needs-you' ? 'needs-you' : 'issues';
}
