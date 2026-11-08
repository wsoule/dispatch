import {
  PRIORITY_LABEL,
  THIS_WEEK_DAYS,
  type TimelineBar,
  type TimelineLane,
  type TimelineView,
  type User,
  type WeekIssueRow,
  type WeekSection,
  type WeekView,
} from '@dispatch/planning';
import type {
  DeadlineGroup,
  DeadlineItem,
  StatCell,
  TaskColumnId,
  TaskGroupData,
  TaskRowData,
  TaskSectionData,
  UiTone,
} from '@dispatch/ui';

import { taskHref, timelineHref } from '../lib/routes';
import {
  daysLeftPhrase,
  dueLabel,
  formatDate,
  formatLongDate,
  greeting,
  plural,
} from './planningFormat';
import {
  assessmentMark,
  blockedReasonLine,
  dueTone,
  progressTone,
  statusLabel,
  type StatusMarkModel,
  uiStatus,
} from './planningStatus';

// My week (Better Tracker's /week, ported): the planning's WeekView (one
// person's open issues grouped by milestone) and TimelineView (every lane,
// bar and allocation outcome) mapped onto @dispatch/ui's StatsStrip,
// TaskGroupTable, DeadlineList and the "Needs attention" register. Pure, so
// every line of copy is unit-tested (week.test.ts). Inactive projects are
// never loud: their issues stay listed in greys, but no count, deadline or
// attention row includes them, and the stats say how many were left out.

/** The table's meta columns: the group heading already names the project. */
export const WEEK_TASK_COLUMNS: TaskColumnId[] = ['state', 'priority', 'due'];

/** One row of the "Needs attention" register (projects the person leads). */
export interface WeekAttentionItem {
  id: string;
  projectName: string;
  /** Why it needs attention, under the name. */
  detail: string;
  /** The chip at the row's end: "Blocked", "2 unassigned". */
  flag: string;
  tone: UiTone;
  href: string;
  rowLabel: string;
}

export interface WeekPageModel {
  userId: string;
  /** This window's own person is looking at their own week. */
  isSelf: boolean;
  heading: string;
  receipts: string;
  stats: StatCell[];
  issuesTitle: string;
  issuesMeta: string;
  sections: TaskSectionData[];
  emptyMessage: string;
  deadlines: DeadlineGroup[];
  attention: WeekAttentionItem[];
  attentionEmpty: string;
}

export interface WeekPageInput {
  week: WeekView;
  timeline: TimelineView;
  /** This window's person (differs from week.userId on someone else's week). */
  viewerId: string | null;
  /** Local hour 0–23, for the greeting. */
  hour: number;
  /** How long an auto-assigned issue stays "new" (tuning.newBadgeDays). */
  newBadgeDays: number;
  /** The project of each "No milestone" issue, from the snapshot. */
  issueProjects: ReadonlyMap<string, { projectId: string; name: string }>;
}

/** Wording shared by every part of the page. */
interface WeekCopy {
  isSelf: boolean;
  /** Their first name ("them" when unknown). */
  name: string;
}

type BarIndex = Map<string, { bar: TimelineBar; lane: TimelineLane }>;

/**
 * Options for the "Showing" person picker: people (never agents or the
 * pool), active ones by name, then inactive ones marked so. The viewer is
 * marked "(you)".
 */
export function weekPeopleOptions(
  users: Iterable<User>,
  viewerId: string | null
): { value: string; label: string }[] {
  const people = [...users].filter((user) => !user.app);
  const byName = (a: User, b: User) => a.name.localeCompare(b.name, 'en');
  const active = people.filter((user) => user.active).sort(byName);
  const inactive = people.filter((user) => !user.active).sort(byName);
  return [
    ...active.map((user) => ({
      value: user.id,
      label: user.id === viewerId ? `${user.name} (you)` : user.name,
    })),
    ...inactive.map((user) => ({
      value: user.id,
      label: `${user.name} (inactive)`,
    })),
  ];
}

/**
 * Whose week to show: the asked-for person when the planning knows them,
 * else the viewer, else the first person listed (a window that does not yet
 * know who it is still shows a week rather than nothing).
 */
export function resolveWeekUserId(input: {
  requested: string | null;
  viewerId: string | null;
  knownUserIds: ReadonlySet<string>;
}): string | null {
  const { requested, viewerId, knownUserIds } = input;
  if (requested !== null && knownUserIds.has(requested)) return requested;
  if (viewerId !== null && knownUserIds.has(viewerId)) return viewerId;
  const [first] = knownUserIds;
  return first ?? null;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** "+1 in an inactive project", "+2 in inactive projects". */
function inactiveNote(count: number): string {
  return count === 1
    ? '+1 in an inactive project'
    : `+${count} in inactive projects`;
}

// A stat note that also says how many were left out as inactive.
function statNote(
  named: string | null,
  fallback: string,
  inactive: number
): string {
  if (inactive === 0) return named ?? fallback;
  return named === null
    ? inactiveNote(inactive)
    : `${named} · ${inactiveNote(inactive)}`;
}

function indexBars(timeline: TimelineView): BarIndex {
  const index: BarIndex = new Map();
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      for (const bar of [...lane.bars, ...lane.undated]) {
        index.set(bar.milestoneId, { bar, lane });
      }
    }
  }
  return index;
}

// Only a lane marked inactive quiets a milestone; one with no lane (its
// project completed or canceled) keeps its status.
function milestoneActive(bars: BarIndex, milestoneId: string | null): boolean {
  if (milestoneId === null) return true;
  return bars.get(milestoneId)?.lane.active ?? true;
}

interface NoMilestoneProject {
  projectId: string;
  name: string;
  /** The project has a timeline lane (not completed or canceled). */
  onTimeline: boolean;
}

// The project of every unplanned issue: the lanes first (they link to the
// lane), then the snapshot's issue → project map for lane-less projects.
function noMilestoneProjects(
  timeline: TimelineView,
  issueProjects: ReadonlyMap<string, { projectId: string; name: string }>
): Map<string, NoMilestoneProject> {
  const projects = new Map<string, NoMilestoneProject>();
  const lanes = new Set<string>();
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      lanes.add(lane.projectId);
      for (const issueId of lane.unplannedIssueIds) {
        projects.set(issueId, {
          projectId: lane.projectId,
          name: lane.name,
          onTimeline: true,
        });
      }
    }
  }
  for (const [issueId, project] of issueProjects) {
    if (projects.has(issueId)) continue;
    projects.set(issueId, {
      ...project,
      onTimeline: lanes.has(project.projectId),
    });
  }
  return projects;
}

function sectionMark(
  section: WeekSection,
  bar: TimelineBar | undefined
): StatusMarkModel | null {
  if (bar !== undefined) return assessmentMark(bar);
  if (section.status === null) return null;
  return {
    status: uiStatus(section.status),
    label: statusLabel(section.status),
  };
}

function newChipLabel(projectName: string, copy: WeekCopy): string {
  const project = projectName === '' ? 'this project' : projectName;
  return copy.isSelf
    ? `New — given to you because you lead ${project}`
    : `New — given to ${copy.name} because they lead ${project}`;
}

function toTaskRow(
  row: WeekIssueRow,
  section: WeekSection,
  projectName: string | undefined,
  today: string,
  copy: WeekCopy,
  active = true
): TaskRowData {
  // A row's due date is its milestone's, coloured like it; never in an
  // inactive project.
  const tone =
    !active || section.targetDate === null
      ? 'default'
      : dueTone(section.status, section.daysLeft, false);
  return {
    id: row.issueId,
    key: row.identifier,
    title: row.title,
    href: taskHref(row.issueId),
    project: projectName,
    state: row.stateName === '' ? row.stateType : row.stateName,
    stateKind: row.stateType,
    priority: row.priority,
    priorityLabel: PRIORITY_LABEL[row.priority],
    due:
      section.targetDate === null
        ? undefined
        : formatDate(section.targetDate, today),
    dueTone: tone === 'default' ? undefined : tone,
    chips:
      row.newBecauseLeadOf === null
        ? undefined
        : [{ label: newChipLabel(row.newBecauseLeadOf, copy), tone: 'accent' }],
  };
}

function toTaskGroup(
  section: WeekSection,
  bar: TimelineBar | undefined,
  today: string,
  copy: WeekCopy,
  active: boolean
): TaskGroupData {
  const milestoneId = section.milestoneId ?? '';
  const mark = sectionMark(section, bar);
  const overdue = section.status === 'overdue';
  const undated = section.targetDate === null;
  const tone =
    bar !== undefined ? progressTone(bar) : overdue ? 'danger' : 'default';
  const due = dueTone(section.status, section.daysLeft, undated);
  const quiet = {
    statusLabel: mark === null ? undefined : `${mark.label} · inactive project`,
    daysLeftLabel: 'Inactive project',
    muted: true,
    dueTone: undefined,
  };
  return {
    id: milestoneId,
    eyebrow: section.projectName ?? undefined,
    title: section.milestoneName ?? 'Untitled milestone',
    href: taskHref(milestoneId),
    status: mark?.status,
    statusLabel: mark?.label,
    dueLabel:
      section.targetDate === null
        ? dueLabel(null, null, today)
        : formatDate(section.targetDate, today),
    daysLeftLabel:
      section.daysLeft === null ? undefined : daysLeftPhrase(section.daysLeft),
    dueTone: due === 'default' ? undefined : due,
    ...(active ? {} : quiet),
    progress:
      section.progress === null
        ? undefined
        : {
            done: section.progress.completed,
            total: section.progress.scope,
            tone: active ? tone : 'muted',
          },
    rows: section.rows.map((row) =>
      toTaskRow(
        row,
        section,
        section.projectName ?? undefined,
        today,
        copy,
        active
      )
    ),
  };
}

// The "No milestone" section's groups: one per project (linking to its lane
// when it has one), then the issues with no project at all.
function noMilestoneGroups(
  section: WeekSection,
  unplanned: Map<string, NoMilestoneProject>,
  today: string,
  copy: WeekCopy
): TaskGroupData[] {
  const groups = new Map<string, TaskGroupData>();
  const orphans: TaskRowData[] = [];
  for (const row of section.rows) {
    const project = unplanned.get(row.issueId);
    const taskRow = toTaskRow(row, section, project?.name, today, copy);
    if (project === undefined) {
      orphans.push(taskRow);
      continue;
    }
    const existing = groups.get(project.projectId);
    if (existing !== undefined) {
      existing.rows.push(taskRow);
      continue;
    }
    groups.set(project.projectId, {
      id: `no-milestone:${project.projectId}`,
      eyebrow: project.name,
      title: 'Issues without a milestone',
      href: project.onTimeline ? timelineHref(project.projectId) : undefined,
      rows: [taskRow],
    });
  }
  const result = [...groups.values()];
  if (orphans.length > 0) {
    result.push({
      id: 'no-milestone:none',
      title: 'Issues without a project or milestone',
      rows: orphans,
    });
  }
  return result;
}

// This week / Later / No milestone, in the planning's milestone order. This
// week is always there once anything is, so "nothing due" is said.
function buildSections(
  week: WeekView,
  bars: BarIndex,
  unplanned: Map<string, NoMilestoneProject>,
  copy: WeekCopy
): TaskSectionData[] {
  const thisWeek: TaskGroupData[] = [];
  const later: TaskGroupData[] = [];
  const noMilestone: TaskGroupData[] = [];
  for (const section of week.sections) {
    if (section.milestoneId === null) {
      noMilestone.push(
        ...noMilestoneGroups(section, unplanned, week.today, copy)
      );
      continue;
    }
    const group = toTaskGroup(
      section,
      bars.get(section.milestoneId)?.bar,
      week.today,
      copy,
      milestoneActive(bars, section.milestoneId)
    );
    (section.thisWeek ? thisWeek : later).push(group);
  }
  if (thisWeek.length + later.length + noMilestone.length === 0) return [];
  const sections: TaskSectionData[] = [
    {
      id: 'this-week',
      label: 'This week',
      emptyLabel: copy.isSelf
        ? 'Nothing of yours is due this week.'
        : `Nothing of ${copy.name}'s is due this week.`,
      groups: thisWeek,
    },
  ];
  if (later.length > 0) {
    sections.push({ id: 'later', label: 'Later', groups: later });
  }
  if (noMilestone.length > 0) {
    sections.push({
      id: 'no-milestone',
      label: 'No milestone',
      groups: noMilestone,
    });
  }
  return sections;
}

/** "Project · Milestone", or "… and 2 more" for a list of them. */
function nameList(items: { project: string; milestone: string }[]): string {
  const [first, ...rest] = items;
  if (first === undefined) return '';
  const head = `${first.project} · ${first.milestone}`;
  return rest.length === 0 ? head : `${head} and ${rest.length} more`;
}

/**
 * Overdue, then at-risk milestones in the projects the person leads. Only
 * active projects by default; `inactive: true` lists the quiet ones, for the
 * "+1" note.
 */
export function atRiskInLedProjects(
  timeline: TimelineView,
  userId: string,
  { inactive = false }: { inactive?: boolean } = {}
): { milestoneId: string; project: string; milestone: string }[] {
  const overdue: { milestoneId: string; project: string; milestone: string }[] =
    [];
  const atRisk: typeof overdue = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId || lane.active === inactive) continue;
      for (const bar of [...lane.bars, ...lane.undated]) {
        const item = {
          milestoneId: bar.milestoneId,
          project: lane.name,
          milestone: bar.name,
        };
        if (bar.status === 'overdue') overdue.push(item);
        else if (bar.status === 'at_risk') atRisk.push(item);
      }
    }
  }
  return [...overdue, ...atRisk];
}

function overdueSections(
  week: WeekView,
  bars: BarIndex
): { active: WeekSection[]; inactive: number } {
  const active: WeekSection[] = [];
  let inactive = 0;
  for (const section of week.sections) {
    if (section.status !== 'overdue' || section.milestoneId === null) continue;
    if (milestoneActive(bars, section.milestoneId)) active.push(section);
    else inactive += 1;
  }
  return { active, inactive };
}

function buildStats(
  week: WeekView,
  timeline: TimelineView,
  bars: BarIndex,
  copy: WeekCopy,
  newBadgeDays: number,
  leadsProjects: boolean
): StatCell[] {
  const late = overdueSections(week, bars);
  const overdueNames = late.active.map((section) => ({
    project: section.projectName ?? '',
    milestone: section.milestoneName ?? '',
  }));
  const onlyOverdueId =
    late.active.length === 1 ? late.active[0]?.milestoneId : null;

  const newProjects = new Set<string>();
  for (const section of week.sections) {
    for (const row of section.rows) {
      if (row.newBecauseLeadOf !== null) newProjects.add(row.newBecauseLeadOf);
    }
  }
  const [onlyNewProject] = [...newProjects];
  const leadVerb = copy.isSelf ? 'you lead' : 'they lead';
  const newNote =
    week.totals.new === 0
      ? `None in the last ${plural(newBadgeDays, 'day')}`
      : newProjects.size === 1 && onlyNewProject !== undefined
        ? `Because ${leadVerb} ${onlyNewProject === '' ? 'the project' : onlyNewProject}`
        : `Because ${leadVerb} ${plural(newProjects.size, 'project')}`;

  const risky = atRiskInLedProjects(timeline, week.userId);
  const quietRisky = atRiskInLedProjects(timeline, week.userId, {
    inactive: true,
  }).length;
  const onlyRisky = risky.length === 1 ? risky[0] : undefined;
  const noLead = copy.isSelf
    ? 'You lead no projects'
    : `${copy.name} leads no projects`;

  return [
    {
      id: 'open',
      label: 'Open issues',
      value: week.totals.open,
      note: `${week.totals.thisWeek} this week`,
    },
    {
      id: 'overdue',
      label: 'Overdue milestones',
      value: late.active.length,
      note: statNote(
        overdueNames.length === 0 ? null : nameList(overdueNames),
        'None',
        late.inactive
      ),
      tone: late.active.length > 0 ? 'danger' : 'default',
      href:
        onlyOverdueId === null || onlyOverdueId === undefined
          ? undefined
          : taskHref(onlyOverdueId),
    },
    {
      id: 'new',
      label: copy.isSelf ? 'New to you' : `New to ${copy.name}`,
      value: week.totals.new,
      note: newNote,
    },
    {
      id: 'risk',
      label: copy.isSelf
        ? 'At risk in your projects'
        : `At risk in ${copy.name}'s projects`,
      value: risky.length,
      note: statNote(
        risky.length > 0 ? nameList(risky) : null,
        leadsProjects ? 'Nothing at risk or overdue' : noLead,
        quietRisky
      ),
      tone: risky.length > 0 ? 'warning' : 'default',
      href:
        onlyRisky === undefined ? undefined : taskHref(onlyRisky.milestoneId),
    },
  ];
}

/**
 * Upcoming deadlines: dated, unfinished milestones in active projects the
 * person leads or has open issues in, as Overdue / Today / Tomorrow / This
 * week (up to THIS_WEEK_DAYS out), nearest first.
 */
function buildDeadlines(
  week: WeekView,
  timeline: TimelineView,
  bars: BarIndex
): DeadlineGroup[] {
  const ids = new Set<string>();
  for (const section of week.sections) {
    if (section.milestoneId !== null) ids.add(section.milestoneId);
  }
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== week.userId) continue;
      for (const bar of lane.bars) ids.add(bar.milestoneId);
    }
  }

  type Dated = { item: DeadlineItem; daysLeft: number };
  const overdue: Dated[] = [];
  const today: Dated[] = [];
  const tomorrow: Dated[] = [];
  const soon: Dated[] = [];
  for (const id of ids) {
    const entry = bars.get(id);
    if (entry === undefined) continue;
    const { bar, lane } = entry;
    if (!lane.active || bar.end === null || bar.daysLeft === null) continue;
    if (bar.status === 'complete') continue;
    const mark = assessmentMark(bar);
    const unassigned = bar.progress.openUnassigned;
    const item: DeadlineItem = {
      id: bar.milestoneId,
      label: bar.name,
      // The count first: the panel is narrow and cuts the line's end.
      sublabel: `${
        unassigned > 0
          ? `${unassigned} unassigned`
          : `${bar.progress.open} open`
      } · ${lane.name}`,
      href: taskHref(bar.milestoneId),
      status: mark.status,
      statusLabel: mark.label,
      dueLabel: formatDate(bar.end, week.today),
    };
    const dated = { item, daysLeft: bar.daysLeft };
    if (bar.status === 'overdue') overdue.push(dated);
    else if (bar.daysLeft === 0) today.push(dated);
    else if (bar.daysLeft === 1) tomorrow.push(dated);
    else if (bar.daysLeft > 1 && bar.daysLeft <= THIS_WEEK_DAYS) {
      soon.push(dated);
    }
  }
  const sorted = (list: Dated[]) =>
    [...list]
      .sort((a, b) =>
        a.daysLeft === b.daysLeft
          ? a.item.label.localeCompare(b.item.label, 'en')
          : a.daysLeft - b.daysLeft
      )
      .map((entry) => entry.item);
  return [
    {
      id: 'overdue',
      label: 'Overdue',
      tone: overdue.length > 0 ? 'danger' : 'default',
      items: sorted(overdue),
    },
    {
      id: 'today',
      label: 'Today',
      tone: today.length > 0 ? 'warning' : 'default',
      items: sorted(today),
    },
    {
      id: 'tomorrow',
      label: 'Tomorrow',
      tone: tomorrow.length > 0 ? 'warning' : 'default',
      items: sorted(tomorrow),
    },
    { id: 'this-week', label: 'This week', items: sorted(soon) },
  ];
}

/**
 * Needs attention: active projects the person leads whose allocation is
 * blocked (with the reason), or whose next milestone has open unassigned
 * issues. Blocked first, each project once.
 */
export function buildAttention(
  timeline: TimelineView,
  userId: string
): WeekAttentionItem[] {
  const blocked: WeekAttentionItem[] = [];
  const unassigned: WeekAttentionItem[] = [];
  for (const group of timeline.groups) {
    for (const lane of group.lanes) {
      if (lane.leadId !== userId || !lane.active) continue;
      const next = [...lane.bars, ...lane.undated].find((bar) => bar.isNext);
      const plan = lane.allocation;
      if (plan?.outcome === 'blocked' && plan.blockReason !== null) {
        const detail = blockedReasonLine(plan.blockReason, plan.gaps);
        blocked.push({
          id: lane.projectId,
          projectName: lane.name,
          detail,
          flag: 'Blocked',
          tone: 'warning',
          href:
            plan.nextMilestoneId === null
              ? timelineHref(lane.projectId)
              : taskHref(plan.nextMilestoneId),
          rowLabel: `${lane.name}: allocation blocked. ${detail}`,
        });
        continue;
      }
      if (next !== undefined && next.progress.openUnassigned > 0) {
        const count = next.progress.openUnassigned;
        unassigned.push({
          id: lane.projectId,
          projectName: lane.name,
          detail: `Next: ${next.name}`,
          flag: `${count} unassigned`,
          tone: 'warning',
          href: taskHref(next.milestoneId),
          rowLabel: `${lane.name}: ${plural(count, 'open issue')} unassigned in ${next.name}`,
        });
      }
    }
  }
  return [...blocked, ...unassigned];
}

function leadsAnyProject(timeline: TimelineView, userId: string): boolean {
  return timeline.groups.some((group) =>
    group.lanes.some((lane) => lane.leadId === userId)
  );
}

// The empty line, naming inactive projects that were left out so a paused
// project is not mistaken for one that was missed.
function attentionEmptyLine(
  timeline: TimelineView,
  userId: string,
  copy: WeekCopy,
  leadsProjects: boolean
): string {
  if (!leadsProjects) {
    return copy.isSelf
      ? 'You lead no projects'
      : `${copy.name} leads no projects`;
  }
  const base = copy.isSelf
    ? 'Nothing needs attention in the projects you lead'
    : `Nothing needs attention in the projects ${copy.name} leads`;
  const inactive = timeline.groups.flatMap((group) =>
    group.lanes
      .filter((lane) => lane.leadId === userId && !lane.active)
      .map((lane) => lane.name)
  );
  if (inactive.length === 0) return base;
  return inactive.length === 1
    ? `${base}. ${inactive[0]} is inactive, so it is left out`
    : `${base}. ${inactive.length} inactive projects are left out`;
}

/** Everything the My week page draws, from the two planning views. */
export function buildWeekPage(input: WeekPageInput): WeekPageModel {
  const { week, timeline } = input;
  const isSelf = week.userId === input.viewerId;
  const name = firstName(week.userName);
  const copy: WeekCopy = { isSelf, name: name === '' ? 'them' : name };
  const bars = indexBars(timeline);
  const unplanned = noMilestoneProjects(timeline, input.issueProjects);
  const leadsProjects = leadsAnyProject(timeline, week.userId);

  const heading = isSelf
    ? name === ''
      ? greeting(input.hour)
      : `${greeting(input.hour)}, ${name}`
    : week.userName === ''
      ? 'Their week'
      : `${week.userName}'s week`;

  const overdue = overdueSections(week, bars).active.length;
  const receipts = [
    formatLongDate(week.today),
    week.totals.thisWeek === 0
      ? 'Nothing due this week'
      : `${plural(week.totals.thisWeek, 'issue')} due this week`,
  ];
  if (overdue > 0) receipts.push(`${plural(overdue, 'milestone')} overdue`);

  return {
    userId: week.userId,
    isSelf,
    heading,
    receipts: receipts.join(' · '),
    stats: buildStats(
      week,
      timeline,
      bars,
      copy,
      input.newBadgeDays,
      leadsProjects
    ),
    issuesTitle: isSelf
      ? 'Your issues'
      : week.userName === ''
        ? 'Their issues'
        : `${week.userName}'s issues`,
    issuesMeta: `${week.totals.open} open`,
    sections: buildSections(week, bars, unplanned, copy),
    emptyMessage: isSelf
      ? "Nothing assigned to you is open. Work in your projects' next milestones lands here once it is allocated."
      : `Nothing assigned to ${week.userName === '' ? 'this person' : week.userName} is open.`,
    deadlines: buildDeadlines(week, timeline, bars),
    attention: buildAttention(timeline, week.userId),
    attentionEmpty: attentionEmptyLine(
      timeline,
      week.userId,
      copy,
      leadsProjects
    ),
  };
}
