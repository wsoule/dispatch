import type {
  ProjectStatusType,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import { graphScopeFor, NO_INITIATIVE_ID } from '@dispatch/planning';
import { noProjectId } from '@dispatch/planning';
import type { ChipTone, SegmentedOption, UiStatus, UiTone } from '@dispatch/ui';

import { graphHref, taskHref, timelineHref } from '../lib/routes';
import { dueLabel, plural } from './planningFormat';
import {
  assessmentMark,
  dueTone,
  type ProgressTone,
  progressTone,
} from './planningStatus';

// The Projects register (the planner's lib/adapters/projects.ts, ported over
// Dispatch's data): one row per lane of the planning's TimelineView (every
// project that is not completed or canceled), grouped by initiative in the
// timeline's order with "No initiative" last. Each row carries the project's
// own status, its next milestone (mark, due line, progress) and its lead.
// Pure functions over plain data, so the view only filters and draws.
//
// What changed in the port: a project, a milestone and an initiative are all
// tasks, so the row opens the project's task (`taskHref`) where the planner
// linked to Linear; the row itself leads to the project's timeline lane; the
// Issues link is gone (the Issues list has no route that narrows it to one
// project); the status name is the task's own status under the project's
// status model; and the synthetic "No project" lane the workspace synthesis
// makes for loose milestones is not a project, so it is left out.
//
// Tones follow the status table (packages/ui/README.md "Status vocabulary"):
// overdue danger, at risk / blocked / no lead / missing date warning, complete
// success, agents working / allocating / a started project info, inactive
// muted. The accent never means a status here.

export type ProjectFilterId = 'all' | 'blocked' | 'at_risk' | 'inactive';

const PROJECT_FILTER_IDS: readonly ProjectFilterId[] = [
  'all',
  'blocked',
  'at_risk',
  'inactive',
];

const FILTER_LABEL: Record<ProjectFilterId, string> = {
  all: 'All',
  blocked: 'Blocked',
  at_risk: 'At risk',
  inactive: 'Inactive',
};

/** The status chip's words when the planning knows no name for the
 * project (its task left the list between two renders). Sentence case. */
const STATUS_TYPE_LABEL: Record<ProjectStatusType, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  started: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

/** A project's status type as a chip tone, for an active project; an
 * inactive one's chip is muted whatever its status (see toRow). Backlog and
 * planned keep the neutral badge: grey means inactive, and an active project
 * that has not started yet is not inactive. */
const STATUS_TONE: Record<ProjectStatusType, ChipTone> = {
  backlog: 'default',
  planned: 'default',
  started: 'info',
  paused: 'warning',
  completed: 'success',
  canceled: 'muted',
};

interface ProjectNextMilestone {
  id: string;
  name: string;
  /** "Oct 18 · 3 days overdue", "No target date". */
  dueLabel: string;
  /** The due date's colour (dueTone): danger overdue, warning due today or
   * tomorrow or undated (a missing input), default later, muted in an
   * inactive project. */
  dueTone: UiTone;
  status: UiStatus;
  statusLabel: string;
  done: number;
  total: number;
  /** The progress fill (progressTone): danger overdue, warning behind pace,
   * success complete, muted in an inactive project, default (the accent
   * fill) otherwise. */
  progressTone: ProgressTone;
  /** An inactive project's milestone: the mark is drawn in greys. */
  muted: boolean;
}

export interface ProjectRowModel {
  id: string;
  name: string;
  initiative: string;
  /** The project's status name ("Working", "Ready"). */
  status: string;
  /** The status chip's tone (STATUS_TONE); always muted for an inactive
   * project, whose row carries no status colour: there the register draws
   * it as the grey-dot pill (Chip `dot`), so the column stays a column of
   * status pills. */
  statusTone: ChipTone;
  /** Allocation and warnings apply to this project. */
  active: boolean;
  next: ProjectNextMilestone | null;
  /** null renders "No lead" in the warning tone. */
  lead: string | null;
  /** The register row's tone, data only: warning when allocation is
   * blocked, muted for an inactive project (its subject steps back). */
  rowTone: 'default' | 'warning' | 'muted';
  /** The filters (other than "all") this row matches. */
  tags: ProjectFilterId[];
  /** The row itself: the Timeline opened on this project's lane. */
  timelineHref: string;
  /** The dependency graph scoped to this project. */
  graphHref: string;
  /** The project's own page (its Flight Plan). */
  openHref: string;
  /** Lower-cased words the search box matches against. */
  searchText: string;
}

export interface ProjectGroupModel {
  /** Initiative id, or NO_INITIATIVE_ID for "No initiative". */
  id: string;
  name: string;
  /** The group's dependency graph: its projects, or the workspace's projects
   * when there are no initiatives. */
  graphHref: string;
  /** The workspace has no initiatives: the one "No initiative" group draws
   * no heading over its rows. */
  headless: boolean;
  rows: ProjectRowModel[];
}

export interface ProjectsPageModel {
  groups: ProjectGroupModel[];
  /** SegmentedControl options with counts: All / Blocked / At risk / Inactive. */
  filters: SegmentedOption[];
  total: number;
  /** "9 projects in 3 initiatives · 2 at risk". */
  receipts: string;
}

export interface ProjectsPageInput {
  timeline: TimelineView;
  /** The planning snapshot's projects, for each one's status name. */
  projects: ReadonlyMap<string, { statusName: string }>;
}

/**
 * The register's next-milestone cell: the lane's bar marked `isNext`, dated
 * or not. In an inactive project it is never loud: grey mark (still named
 * with its status), muted date, grey progress.
 */
function nextMilestone(
  lane: TimelineLane,
  today: string
): ProjectNextMilestone | null {
  const bar = [...lane.bars, ...lane.undated].find((b) => b.isNext);
  if (bar === undefined) return null;
  const mark = assessmentMark(bar);
  const loud = lane.active;
  return {
    id: bar.milestoneId,
    name: bar.name,
    dueLabel: dueLabel(bar.end, bar.daysLeft, today, bar.status),
    // A missing date is a fact, not an alarm: amber is for due soon or late.
    dueTone:
      loud && bar.end !== null
        ? dueTone(bar.status, bar.daysLeft, false)
        : 'muted',
    status: mark.status,
    statusLabel: loud ? mark.label : `${mark.label} · inactive project`,
    done: bar.progress.completed,
    total: bar.progress.scope,
    progressTone: progressTone(bar, !loud),
    muted: !loud,
  };
}

function toRow(
  lane: TimelineLane,
  initiative: string,
  input: ProjectsPageInput
): ProjectRowModel {
  const next = nextMilestone(lane, input.timeline.today);
  const blocked = lane.allocation?.outcome === 'blocked';
  const atRisk =
    lane.active &&
    next !== null &&
    (next.status === 'overdue' || next.status === 'at_risk');
  const tags: ProjectFilterId[] = [];
  if (blocked) tags.push('blocked');
  if (atRisk) tags.push('at_risk');
  if (!lane.active) tags.push('inactive');
  const status =
    input.projects.get(lane.projectId)?.statusName ??
    STATUS_TYPE_LABEL[lane.statusType];
  return {
    id: lane.projectId,
    name: lane.name,
    initiative,
    status,
    // An inactive project's row carries no status colour.
    statusTone: lane.active ? STATUS_TONE[lane.statusType] : 'muted',
    active: lane.active,
    next,
    lead: lane.leadName,
    rowTone: blocked ? 'warning' : lane.active ? 'default' : 'muted',
    tags,
    timelineHref: timelineHref(lane.projectId),
    graphHref: graphHref(
      graphScopeFor({ kind: 'project', id: lane.projectId })
    ),
    openHref: taskHref(lane.projectId),
    searchText: [
      lane.name,
      initiative,
      status,
      lane.leadName ?? 'no lead',
      next?.name ?? '',
    ]
      .join(' ')
      .toLowerCase(),
  };
}

/** Accepts a filter id from a control; anything unknown means "all". */
export function parseProjectFilter(value: unknown): ProjectFilterId {
  return PROJECT_FILTER_IDS.find((id) => id === value) ?? 'all';
}

/**
 * The rows that match a search and a filter, still grouped (groups left
 * empty are dropped). Every whitespace-separated word of the query must
 * appear in the row's name, initiative, status, lead or next milestone.
 */
export function filterProjectGroups(
  groups: readonly ProjectGroupModel[],
  query: string,
  filter: ProjectFilterId
): ProjectGroupModel[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const result: ProjectGroupModel[] = [];
  for (const group of groups) {
    const rows = group.rows.filter(
      (row) =>
        (filter === 'all' || row.tags.includes(filter)) &&
        words.every((word) => row.searchText.includes(word))
    );
    if (rows.length > 0) result.push({ ...group, rows });
  }
  return result;
}

/** How many rows are in a set of groups. */
export function countProjectRows(groups: readonly ProjectGroupModel[]): number {
  return groups.reduce((sum, group) => sum + group.rows.length, 0);
}

/** Everything the Projects page renders, from the planning. */
export function buildProjectsPage(input: ProjectsPageInput): ProjectsPageModel {
  const { timeline } = input;
  // Without initiatives every group is "No initiative", and its graph link
  // goes to the workspace's projects.
  const hasInitiatives = timeline.groups.some(
    (group) => group.initiativeId !== null
  );
  const groups: ProjectGroupModel[] = [];
  for (const group of timeline.groups) {
    const id = group.initiativeId ?? NO_INITIATIVE_ID;
    // The synthetic lane holding an initiative's loose milestones is not a
    // project: nothing to open, allocate or lead.
    const synthetic = noProjectId(group.initiativeId);
    const rows = group.lanes
      .filter((lane) => lane.projectId !== synthetic)
      // With no initiatives anywhere, "No initiative" under every name says nothing.
      .map((lane) => toRow(lane, hasInitiatives ? group.name : '', input));
    if (rows.length === 0) continue;
    groups.push({
      id,
      name: group.name,
      graphHref: hasInitiatives
        ? graphHref(graphScopeFor({ kind: 'initiative', id }))
        : graphHref({ level: 'project' }),
      headless: !hasInitiatives,
      rows,
    });
  }
  const rows = groups.flatMap((group) => group.rows);
  const count = (id: ProjectFilterId) =>
    id === 'all'
      ? rows.length
      : rows.filter((row) => row.tags.includes(id)).length;
  const initiatives = groups.filter(
    (group) => group.id !== NO_INITIATIVE_ID
  ).length;
  const receipts = [
    initiatives === 0
      ? plural(rows.length, 'project')
      : `${plural(rows.length, 'project')} in ${plural(initiatives, 'initiative')}`,
    ...(count('at_risk') > 0 ? [`${count('at_risk')} at risk`] : []),
  ].join(' · ');
  return {
    groups,
    filters: PROJECT_FILTER_IDS.map((id) => ({
      id,
      label: FILTER_LABEL[id],
      count: count(id),
    })),
    total: rows.length,
    receipts,
  };
}
