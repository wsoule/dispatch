import type { EpicProgress } from '@dispatch/client';
import type {
  ProjectAllocationPlan,
  ProjectStatusType,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import { graphScopeFor, NO_INITIATIVE_ID } from '@dispatch/planning';
import type { ChipTone, SegmentedOption, UiStatus, UiTone } from '@dispatch/ui';

import { graphHref, taskHref, timelineHref } from '../lib/routes';
import { dueLabel, plural } from './planningFormat';
import {
  assessmentMark,
  blockedReasonLine,
  dueTone,
  type ProgressTone,
  progressTone,
} from './planningStatus';
import { noProjectId } from './workspaceData';

// The Projects register (the planner's lib/adapters/projects.ts, ported over
// Dispatch's data): one row per lane of the planning's TimelineView (every
// project that is not completed or canceled), grouped by initiative in the
// timeline's order with "No initiative" last. Each row carries the project's
// own status, its next milestone (mark, due line, progress), its lead and an
// allocation cell in Dispatch's terms: how many agents are working under the
// project right now, else what the planning's allocation plan would do with
// it. Pure functions over plain data, so the view only filters and draws.
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

export interface ProjectAllocationCell {
  /** The chip: "2 agents working", "Allocating 2", "Blocked", "Nothing to do". */
  label: string;
  /** The line under it: why allocation is blocked (blockedReasonLine). */
  detail?: string;
  /** info = agents working or allocating, default = nothing to do, warning
   * = blocked, muted = nothing applies (no open milestone, inactive). */
  tone: 'default' | 'muted' | 'info' | 'warning';
  /** Blocked is the tinted amber chip (Chip `filled`); the info cells are
   * the blue dot pill, the muted cells plain quiet text. */
  filled?: true;
  /** Drawn as plain words, not a chip: "Nothing to do" is quiet meta. */
  plain?: true;
  /** The `detail` line takes the chip's tone too (RegisterCell `toneSub`):
   * set for Blocked, whose reason is the point of the cell. */
  toneDetail?: true;
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
  allocation: ProjectAllocationCell;
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

/** What the register reads about the agents under a container: the runs
 * live right now (`EpicProgress.liveRuns`), by container id. */
export type LiveRunsByContainer = ReadonlyMap<
  string,
  Pick<EpicProgress, 'liveRuns'>
>;

export interface ProjectsPageInput {
  timeline: TimelineView;
  /** The planning snapshot's projects, for each one's status name. */
  projects: ReadonlyMap<string, { statusName: string }>;
  /** Fan-out progress per container (`DispatchProjectData.epicProgressById`):
   * the runs live under a project or one of its milestones are the agents
   * working on it. */
  epicProgressById: LiveRunsByContainer;
}

/**
 * How many agents work under a project right now: the distinct runs live
 * under the project's own fan-out and under each of its milestones' (a
 * plan-wide session lists a milestone's runs under the project too, so the
 * ids are deduplicated rather than summed).
 */
export function agentsWorking(
  lane: Pick<TimelineLane, 'projectId' | 'bars' | 'undated'>,
  epicProgressById: LiveRunsByContainer
): number {
  const runIds = new Set<string>();
  const collect = (containerId: string) => {
    const progress = epicProgressById.get(containerId);
    if (progress === undefined) return;
    for (const run of progress.liveRuns) runIds.add(run.id);
  };
  collect(lane.projectId);
  for (const bar of lane.bars) collect(bar.milestoneId);
  for (const bar of lane.undated) collect(bar.milestoneId);
  return runIds.size;
}

/**
 * The allocation cell: agents working first (what is happening beats what
 * would), else what the planning's allocation plan says, else "Nothing to
 * do" when the planning has no plan for the project.
 */
export function allocationCell(
  agents: number,
  plan: ProjectAllocationPlan | null
): ProjectAllocationCell {
  if (agents > 0) {
    return { label: `${plural(agents, 'agent')} working`, tone: 'info' };
  }
  if (plan === null) {
    return { label: 'Nothing to do', tone: 'default', plain: true };
  }
  switch (plan.outcome) {
    case 'allocate':
      return { label: `Allocating ${plan.actions.length}`, tone: 'info' };
    case 'blocked':
      // A short chip; the reason goes on the line under it, worded as on
      // the timeline's Blocked banner.
      return plan.blockReason === null
        ? { label: 'Blocked', tone: 'warning', filled: true }
        : {
            label: 'Blocked',
            detail: blockedReasonLine(plan.blockReason, plan.gaps),
            tone: 'warning',
            filled: true,
            toneDetail: true,
          };
    case 'nothing_to_do':
      return { label: 'Nothing to do', tone: 'default', plain: true };
    case 'no_open_milestone':
      return { label: 'No open milestone', tone: 'muted' };
    case 'inactive':
      return { label: 'Inactive', tone: 'muted' };
    default: {
      const unreachable: never = plan.outcome;
      return unreachable;
    }
  }
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
    dueTone: loud
      ? dueTone(bar.status, bar.daysLeft, bar.end === null)
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
  const allocation = allocationCell(
    agentsWorking(lane, input.epicProgressById),
    lane.allocation
  );
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
    allocation,
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
      allocation.label,
      allocation.detail ?? '',
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
 * appear in the row's name, initiative, status, lead, next milestone or
 * allocation.
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
      .map((lane) => toRow(lane, group.name, input));
    if (rows.length === 0) continue;
    groups.push({
      id,
      name: group.name,
      graphHref: hasInitiatives
        ? graphHref(graphScopeFor({ kind: 'initiative', id }))
        : graphHref({ level: 'project' }),
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
    `${count('at_risk')} at risk`,
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
