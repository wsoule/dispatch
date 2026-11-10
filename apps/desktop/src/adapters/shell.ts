import { storedKind, type TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneAssessment, Snapshot } from '@dispatch/planning';
import type {
  ShellCrumb,
  ShellNavItem,
  ShellSection,
  ShellSectionItem,
  ShellSettingsLink,
  ShellTab,
  UiStatus,
  UiTone,
} from '@dispatch/ui';

import type { AdminItem } from '../lib/adminItems';
import type { OrbTone } from '../lib/agentPresence';
import { type NavSettingsPage, SETTINGS_PAGE_LABELS } from '../lib/appNav';
import type { ContainerStatus } from '../lib/containerStatus';
import {
  hrefFor,
  PROJECTS_HREF,
  SHELL_ROUTES,
  type ShellDestination,
  shellRoute,
  shellShortcut,
  taskHref,
} from '../lib/shellRoutes';
import { dueDateInfo } from '../lib/taskDates';
import { assessmentMark } from './planningStatus';

// The desktop's app-state → @dispatch/ui shell mapping: the sidebar's primary
// nav with its counts, the Projects section with a status diamond per project,
// the footer's Settings link, the phone tabs and the topbar crumbs. Pure
// functions over plain data so App and DispatchShell stay thin and the
// mapping is unit-tested without React.

/** The Overseer row's badge: what the orb used to say, as a count in a tone. */
export interface OverseerBadge {
  /** Asks or reviews waiting; null when the agent is idle, off or broken. */
  count: number | null;
  tone: OrbTone;
  /** The orb's sentence ("Overseer · 2 waiting on you (work 2)"). */
  label: string;
}

// The orb's hues in the shell's status vocabulary: amber asks, green reviews,
// blue motion, red broken, grey off; idle shows nothing.
const ORB_TONE: Record<OrbTone, UiTone | undefined> = {
  amber: 'warning',
  green: 'success',
  motion: 'info',
  broken: 'danger',
  off: 'muted',
  idle: undefined,
};

/** The count badge's tone for an orb tone (undefined: a quiet number). */
export function orbCountTone(tone: OrbTone): UiTone | undefined {
  return ORB_TONE[tone];
}

export interface ShellNavInput {
  destination: ShellDestination;
  overseer: OverseerBadge;
  /** Asks waiting on this person: the Needs you row's amber count. */
  needsYou: number;
  /** Messages to this person not yet read: the Threads row's accent count. */
  threadsUnread: number;
  /** Runs in the merge queue and failed ones waiting on you: the Landing
   * row's count, red while any failed, a quiet number otherwise. */
  landing?: { active: number; failed: number };
  /** "⌘" or "Ctrl", for the shortcut hints. */
  modLabel: string;
  /** The hosted planner on app.dispatch.foo: planning destinations only. */
  hosted?: boolean;
}

const NAV_DESTINATIONS: readonly ShellDestination[] = [
  'overseer',
  'issues',
  'needs-you',
  'week',
  'timeline',
  'graph',
  'threads',
  'landing',
  'docs',
  'runs',
];

/** What the hosted planner (a Linear workspace on app.dispatch.foo, no
 * machine behind it) can open: the planning views. Agents, threads, docs and
 * runs need a daemon of your own. */
export const HOSTED_DESTINATIONS: ReadonlySet<ShellDestination> = new Set([
  'issues',
  'needs-you',
  'week',
  'timeline',
  'graph',
]);

/** The sidebar's primary rows (Settings sits in the footer). */
export function buildShellNav(input: ShellNavInput): ShellNavItem[] {
  const ids =
    input.hosted === true
      ? NAV_DESTINATIONS.filter((id) => HOSTED_DESTINATIONS.has(id))
      : NAV_DESTINATIONS;
  return ids.map((id) => {
    const route = shellRoute(id);
    const item: ShellNavItem = {
      id,
      label: route.label,
      href: route.href,
      icon: route.icon,
      current: input.destination === id,
      shortcut: shellShortcut(route, input.modLabel),
    };
    if (id === 'overseer' && input.overseer.count !== null) {
      item.count = input.overseer.count;
      item.countLabel = input.overseer.label;
      item.countTone = orbCountTone(input.overseer.tone);
    } else if (id === 'needs-you') {
      item.count = input.needsYou;
      item.countLabel = `${input.needsYou} waiting on you`;
      item.countTone = 'warning';
    } else if (id === 'threads') {
      item.count = input.threadsUnread;
      item.countLabel = `${input.threadsUnread} unread`;
      item.countTone = 'accent';
    } else if (id === 'landing' && input.landing !== undefined) {
      const { active, failed } = input.landing;
      item.count = failed > 0 ? failed : active;
      item.countLabel = `${active} in the queue, ${failed} failed`;
      if (failed > 0) item.countTone = 'danger';
    }
    return item;
  });
}

/** The footer's Settings link, carrying the muted admin count the old
 * "settings ·n" showed, and naming those items in its title. */
export function buildSettingsLink(input: {
  destination: ShellDestination;
  adminItems: readonly AdminItem[];
}): ShellSettingsLink {
  const count = input.adminItems.reduce((n, item) => n + item.count, 0);
  const route = shellRoute('settings');
  return {
    href: route.href,
    label: count > 0 ? `${route.label} · ${count}` : route.label,
    current: input.destination === 'settings',
  };
}

const TAB_DESTINATIONS: readonly ShellDestination[] = [
  'overseer',
  'issues',
  'threads',
  'docs',
];

const HOSTED_TAB_DESTINATIONS: readonly ShellDestination[] = [
  'issues',
  'week',
  'timeline',
  'graph',
];

/** The phone tab bar's cells; the shell appends "More". */
export function buildShellTabs(
  destination: ShellDestination,
  hosted = false
): ShellTab[] {
  return (hosted ? HOSTED_TAB_DESTINATIONS : TAB_DESTINATIONS).map((id) => {
    const route = shellRoute(id);
    return {
      id,
      label: route.label,
      href: route.href,
      icon: route.icon,
      current: destination === id,
    };
  });
}

/** How many projects the sidebar lists before "All" is the way to the rest. */
const PROJECTS_SECTION_LIMIT = 12;

/** A project's sidebar diamond and the words assistive tech reads for it. */
export interface ProjectMark {
  status: UiStatus;
  label: string;
}

export interface ProjectsSectionInput {
  tasks: readonly TaskListItem[];
  /** A container's rolled-up status, or null when nothing is known about it. */
  containerStatusOf: (id: string) => ContainerStatus | null;
  /**
   * The planning's reading of a project, when the window has one: the mark
   * of its next milestone's assessment, as the planner's sidebar drew it (a
   * red or amber diamond only for an overdue or at-risk next milestone, the
   * dotted mark for a missing input, done once every milestone is complete).
   * Null, or no function at all, falls back to `containerStatusOf`.
   */
  statusOf?: (projectId: string) => ProjectMark | null;
  /** The project marked current: the one whose lane the Timeline is focused
   * on (`#/timeline?project=`), or null for none. */
  currentId?: string | null;
  now?: Date;
  limit?: number;
}

/** A project's sidebar diamond from its rolled-up container status: the
 * fallback while no planning reading is at hand. */
export function projectMark(
  status: ContainerStatus | null,
  dueDate: string | null,
  now: Date
): ProjectMark {
  if (status === null || status.total === 0) {
    return { status: 'missing', label: 'No issues yet' };
  }
  if (status.health === 'finished') {
    return { status: 'done', label: 'All issues done' };
  }
  if (dueDate !== null && dueDateInfo(dueDate, now).overdue) {
    return { status: 'overdue', label: 'Overdue' };
  }
  if (status.health === 'attention') {
    return { status: 'at_risk', label: 'Needs attention' };
  }
  return status.health === 'moving'
    ? { status: 'on_track', label: 'In progress' }
    : { status: 'on_track', label: 'On track' };
}

/**
 * The planning's mark for a project, as the planner's sidebar drew it: the
 * assessed mark of its next milestone (red overdue, amber at risk, the dotted
 * mark for a missing input, green on track), or done once every milestone is
 * complete. Null for a project with no milestones (the planning has nothing
 * to say about it), so the caller falls back to the rolled-up status of the
 * issues under it.
 */
export function planningProjectMark(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  projectId: string
): ProjectMark | null {
  const milestones = snapshot.milestonesByProject.get(projectId);
  if (milestones === undefined || milestones.length === 0) return null;
  // Milestones come in date order (undated last): the first still open is next.
  for (const milestone of milestones) {
    const assessment = assessments.get(milestone.id);
    if (assessment === undefined || assessment.status === 'complete') continue;
    return assessmentMark(assessment);
  }
  return { status: 'done', label: 'All milestones complete' };
}

/**
 * The sidebar's Projects section: one row per project-kind container, in
 * list order, each opening the project's own page; "All" opens the Projects
 * page under Tasks, where every project is listed in its initiative's tree.
 * A project's mark is the planning's (`statusOf`) when it has one, else its
 * rolled-up container status. `currentId`'s row is marked current.
 */
export function buildProjectsSection(
  input: ProjectsSectionInput
): ShellSection {
  const now = input.now ?? new Date();
  const limit = input.limit ?? PROJECTS_SECTION_LIMIT;
  const items: ShellSectionItem[] = [];
  for (const doc of input.tasks) {
    if (storedKind(doc.meta.kind) !== 'project') continue;
    if (items.length >= limit) break;
    const mark =
      input.statusOf?.(doc.meta.id) ??
      projectMark(input.containerStatusOf(doc.meta.id), doc.meta.dueDate, now);
    items.push({
      id: doc.meta.id,
      label: doc.meta.title,
      href: taskHref(doc.meta.id),
      status: mark.status,
      statusLabel: mark.label,
      ...(input.currentId === doc.meta.id ? { current: true } : {}),
    });
  }
  return {
    id: 'projects',
    title: 'Projects',
    items,
    emptyLabel: 'No projects yet',
    action: { label: 'All', href: PROJECTS_HREF },
  };
}

export interface CrumbsInput {
  /** The active project, the first crumb; null while none has resolved. */
  projectName: string | null;
  destination: ShellDestination;
  /** The page open under the destination, the last crumb: the open task's
   * title under Issues, or "Live" under Runs (`currentShellPageTitle`). */
  taskTitle?: string | null;
  /** The Settings page showing in the main column (`NavState.settings`), or
   * null while Settings is closed. */
  settingsPage?: NavSettingsPage | null;
  /** The hosted planner: no Overseer, so the project crumb opens the Timeline. */
  hosted?: boolean;
  /** A page with no sidebar row (Files, Terminals, Projects): its title
   * follows the project crumb directly (`onUnlistedPage`). */
  standalonePage?: boolean;
}

/**
 * The topbar breadcrumb: project / destination / open task, or project / page
 * for a page with no sidebar row (Files, Terminals, Projects). While Settings
 * fills the main column it reads project / Settings / page instead: the
 * crumbs name the place, since the page itself has no header row, and a task
 * open beneath Settings is not what shows.
 */
export function buildCrumbs(input: CrumbsInput): ShellCrumb[] {
  const crumbs: ShellCrumb[] = [];
  if (input.projectName !== null && input.projectName !== '') {
    crumbs.push({
      label: input.projectName,
      href: shellRoute(input.hosted === true ? 'timeline' : 'overseer').href,
    });
  }
  const page = input.settingsPage ?? null;
  if (page !== null && input.destination === 'settings') {
    crumbs.push({
      label: shellRoute('settings').label,
      href: hrefFor('settings'),
    });
    crumbs.push({ label: SETTINGS_PAGE_LABELS[page] });
    return crumbs;
  }
  const route = shellRoute(input.destination);
  if (input.standalonePage !== true) {
    crumbs.push({ label: route.label, href: route.href });
  }
  if (input.taskTitle !== undefined && input.taskTitle !== null) {
    crumbs.push({ label: input.taskTitle });
  }
  return crumbs;
}

/** Every destination's label, for a palette or a test. */
export const SHELL_DESTINATION_LABELS: Readonly<
  Record<ShellDestination, string>
> = Object.fromEntries(
  SHELL_ROUTES.map((route) => [route.id, route.label])
) as Record<ShellDestination, string>;
