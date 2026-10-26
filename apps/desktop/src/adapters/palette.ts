import type {
  TimelineBar,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import type { PaletteItem, ShellIcon } from '@dispatch/ui';
import {
  ArrowRight,
  BookText,
  CircleDashed,
  Inbox,
  Layers,
  Play,
  Zap,
} from 'lucide-react';

import type { PaletteEntry, PaletteSection } from '../lib/paletteEntries';
import { formatDate } from './planningFormat';
import { assessmentMark, type StatusMarkModel } from './planningStatus';
import { noProjectId } from './workspaceData';

// Dispatch's palette rows as @dispatch/ui PaletteItems: the entries
// `lib/paletteEntries.ts` builds (tasks, docs, views, navigation, actions)
// with their section heading, default icon and keycaps, and the "Jump to"
// index over the planning's timeline (one row per project lane and per
// milestone bar, marked like the sidebar), ported from the planner's
// buildPaletteIndex (Better-Tracker apps/planner/lib/adapters/shell.ts)
// without its issues part: tasks already have their own section. Pure
// functions over plain data; the host (components/shell/CommandPalette.tsx)
// adds the daemon's doc hits and the recents order.

/** Each entry section's heading in the palette. */
const SECTION_HEADING: Record<PaletteSection, string> = {
  inbox: 'Inbox',
  tasks: 'Tasks',
  docs: 'Docs',
  views: 'Views',
  navigation: 'Navigation',
  actions: 'Actions',
};

/** The heading of the planning's projects and milestones. */
export const JUMP_TO_SECTION = 'Jump to';

/** Section headings in the order the palette lists them: the entry sections
 * in their old order, with the planning's Jump to beside Tasks. */
export const PALETTE_SECTION_ORDER: string[] = [
  SECTION_HEADING.inbox,
  SECTION_HEADING.tasks,
  JUMP_TO_SECTION,
  SECTION_HEADING.docs,
  SECTION_HEADING.views,
  SECTION_HEADING.navigation,
  SECTION_HEADING.actions,
];

/** How many doc hits the palette asks the daemon for per query. */
export const PALETTE_DOCS_LIMIT = 6;

/**
 * How many rows each section shows before "+N more · keep typing", by
 * heading (@dispatch/ui's maxPerSection): the caps the old sectioned menu
 * kept (inbox 3, tasks 8, docs 6, views 4; navigation and actions list every
 * row), with Jump to capped like Tasks, so a project's long task list and
 * its lanes never push Views, Navigation and Actions (New task, Go to
 * Overseer…) below the fold while the query is empty.
 */
export const PALETTE_SECTION_CAPS: Readonly<Record<string, number>> = {
  [SECTION_HEADING.inbox]: 3,
  [SECTION_HEADING.tasks]: 8,
  [JUMP_TO_SECTION]: 8,
  [SECTION_HEADING.docs]: PALETTE_DOCS_LIMIT,
  [SECTION_HEADING.views]: 4,
  [SECTION_HEADING.navigation]: Number.POSITIVE_INFINITY,
  [SECTION_HEADING.actions]: Number.POSITIVE_INFINITY,
};

/** Under "No matches for …": what to try instead. The old menu's empty state. */
export const PALETTE_EMPTY_HINT =
  'Try another task id or title, or press Tab to ask your agent.';

// The glyph a row shows when its entry brings none: one per section.
const SECTION_ICON: Record<PaletteSection, ShellIcon> = {
  inbox: Inbox,
  tasks: CircleDashed,
  docs: BookText,
  views: Layers,
  navigation: ArrowRight,
  actions: Zap,
};

/** A row's icon: its own, else its section's; the "Dispatch …" task rows
 * (`dispatch-<task id>` in buildPaletteEntries) get a play glyph so they
 * read as verbs. */
function iconFor(entry: PaletteEntry): ShellIcon {
  if (entry.icon !== undefined) return entry.icon;
  if (entry.id.startsWith('dispatch-')) return Play;
  return SECTION_ICON[entry.section];
}

/** The ⌘ the entries print for the modifier (lib/paletteEntries.ts). */
const MOD_GLYPH = '⌘';

/**
 * An entry's printed shortcut as the keys the palette draws, one cap each:
 * `G L` → ['G', 'L'], `C` → ['C'], and `⌘1` → [modLabel, '1'] with the
 * platform's modifier label (⌘ on a Mac, Ctrl elsewhere) in the glyph's
 * place, so ⌘ is never shown on Linux or Windows.
 */
export function paletteKeys(shortcut: string, modLabel: string): string[] {
  const keys: string[] = [];
  for (const token of shortcut.split(/\s+/)) {
    if (token === '') continue;
    if (token.startsWith(MOD_GLYPH)) {
      keys.push(modLabel);
      const rest = token.slice(MOD_GLYPH.length);
      if (rest !== '') keys.push(rest);
    } else {
      keys.push(token);
    }
  }
  return keys;
}

export interface ToPaletteItemsOptions {
  /** The platform's modifier label, from @dispatch/ui's useModKeyLabel. */
  modLabel: string;
  /** The entries were matched against the query by their producer (the
   * daemon's doc hits): the palette lists them as given. */
  matched?: true;
}

/**
 * The entries as palette items, in the given order: the section heading
 * for the entry's section, the sublabel as the hint (matched too), the
 * shortcut as keys, the entry's href when it has one, and `run` as
 * onSelect, which the palette's host calls after closing.
 */
export function toPaletteItems(
  entries: readonly PaletteEntry[],
  { modLabel, matched }: ToPaletteItemsOptions
): PaletteItem[] {
  return entries.map((entry): PaletteItem => {
    const item: PaletteItem = {
      id: entry.id,
      label: entry.label,
      section: SECTION_HEADING[entry.section],
      icon: iconFor(entry),
      onSelect: entry.run,
    };
    if (entry.sublabel !== undefined) item.hint = entry.sublabel;
    if (entry.href !== undefined) item.href = entry.href;
    if (entry.shortcut !== undefined) {
      item.shortcut = paletteKeys(entry.shortcut, modLabel);
    }
    if (matched === true) item.matched = true;
    return item;
  });
}

/** The next open milestone of a lane (dated first), or null. */
function laneNextMilestone(lane: TimelineLane): TimelineBar | null {
  return (
    lane.bars.find((bar) => bar.isNext) ??
    lane.undated.find((bar) => bar.isNext) ??
    null
  );
}

/**
 * A project lane's mark, as the sidebar's Projects section draws it
 * (adapters/shell.ts planningProjectMark): its next milestone's assessment
 * mark; without a next milestone every milestone is complete (the solid
 * done mark), or there are none (a missing input).
 */
export function laneMark(lane: TimelineLane): StatusMarkModel {
  const next = laneNextMilestone(lane);
  if (next !== null) return assessmentMark(next);
  if (lane.bars.length + lane.undated.length > 0) {
    return { status: 'done', label: 'All milestones complete' };
  }
  return { status: 'missing', label: 'No milestones' };
}

/**
 * A mark's palette fields. In an inactive project (paused, backlog: never
 * loud) the mark is drawn in greys and its label says why, as on the
 * projects register.
 */
function paletteMark(
  mark: StatusMarkModel,
  active: boolean
): Pick<PaletteItem, 'status' | 'statusLabel' | 'statusMuted'> {
  return active
    ? { status: mark.status, statusLabel: mark.label }
    : {
        status: mark.status,
        statusLabel: `${mark.label} · inactive project`,
        statusMuted: true,
      };
}

/** "Atlas · due Oct 18"; a complete milestone is not "due" any more, so it
 * reads "Atlas · complete · Oct 1"; an undated one "Atlas · no target date". */
function milestoneHint(
  lane: TimelineLane,
  bar: TimelineBar,
  today: string
): string {
  const when =
    bar.end === null
      ? 'no target date'
      : bar.status === 'complete'
        ? `complete · ${formatDate(bar.end, today)}`
        : `due ${formatDate(bar.end, today)}`;
  return `${lane.name} · ${when}`;
}

export interface JumpToHrefs {
  /** A milestone's own page (lib/routes.ts taskHref): a milestone is a task
   * of its kind. */
  task: (taskId: string) => string;
  /** The Timeline on one project's lane (lib/routes.ts timelineHref), where
   * a project row goes, as in the planner and on the projects register. */
  timeline: (projectId: string) => string;
}

/**
 * The "Jump to" rows: every project lane of the timeline (hint "Project ·
 * <lead>" or "Project · No lead", marked like the sidebar) in lane order,
 * then every milestone bar, dated and undated (hint "<project> · due
 * <date>", marked by its assessment). A project row opens its Timeline
 * lane, a milestone row its own page. An inactive lane's rows are muted and
 * say so in the mark's label. The synthetic "No project" lane a group gets
 * for its loose milestones (workspaceData's noProjectId) is no task, so it
 * has no row of its own; its milestones are real tasks and keep theirs.
 */
export function buildJumpToItems(
  timeline: TimelineView,
  hrefs: JumpToHrefs
): PaletteItem[] {
  const projects: PaletteItem[] = [];
  const milestones: PaletteItem[] = [];
  const milestone = (lane: TimelineLane, bar: TimelineBar): PaletteItem => ({
    id: `milestone:${bar.milestoneId}`,
    label: bar.name,
    hint: milestoneHint(lane, bar, timeline.today),
    section: JUMP_TO_SECTION,
    href: hrefs.task(bar.milestoneId),
    ...paletteMark(assessmentMark(bar), lane.active),
  });
  for (const group of timeline.groups) {
    const synthetic = noProjectId(group.initiativeId);
    for (const lane of group.lanes) {
      if (lane.projectId !== synthetic) {
        projects.push({
          id: `project:${lane.projectId}`,
          label: lane.name,
          hint: `Project · ${lane.leadName ?? 'No lead'}`,
          section: JUMP_TO_SECTION,
          href: hrefs.timeline(lane.projectId),
          ...paletteMark(laneMark(lane), lane.active),
        });
      }
      for (const bar of lane.bars) milestones.push(milestone(lane, bar));
      for (const bar of lane.undated) milestones.push(milestone(lane, bar));
    }
  }
  return [...projects, ...milestones];
}
