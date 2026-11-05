// View models for the three screens (§2.11): My week, the timeline, and
// the milestone drawer. Plain data, ready to serialize to the client.

import { addDays, DAY_MS, elapsedMs, isValidIsoDate } from './dates';
import {
  compareIssues,
  compareMilestones,
  groupProjectsByInitiative,
} from './ordering';
import { isOpenState, issueStateType, milestoneTargetDate } from './snapshot';
import type {
  AllocationPlan,
  EvalContext,
  IsoDate,
  Issue,
  Milestone,
  MilestoneAssessment,
  MilestoneDetail,
  MilestoneIssueRow,
  Progress,
  Project,
  RecentAllocation,
  Snapshot,
  TimelineBar,
  TimelineGroup,
  TimelineLane,
  TimelineView,
  WeekIssueRow,
  WeekSection,
  WeekView,
} from './types';

/** Sections due on or before today + this many days count as "this week". */
export const THIS_WEEK_DAYS: number = 6;

const EMPTY_PROGRESS: Progress = {
  total: 0,
  completed: 0,
  canceled: 0,
  scope: 0,
  open: 0,
  openUnassigned: 0,
  openTriage: 0,
};

// The newest live allocation per issue that gave it to `userId` within the
// "new" window, keyed by issue id.
function recentAllocationsFor(
  recent: readonly RecentAllocation[],
  userId: string,
  now: string,
  newBadgeDays: number
): Map<string, RecentAllocation> {
  const byIssue = new Map<string, RecentAllocation>();
  for (const allocation of recent) {
    if (allocation.assigneeId !== userId) continue;
    const age = elapsedMs(now, allocation.at);
    if (age === null || age > newBadgeDays * DAY_MS) continue;
    const current = byIssue.get(allocation.issueId);
    const newer =
      current === undefined || (elapsedMs(allocation.at, current.at) ?? 0) > 0;
    if (newer) byIssue.set(allocation.issueId, allocation);
  }
  return byIssue;
}

/**
 * My week (§7.1): one section per milestone holding the user's open issues,
 * in milestone display order, rows in issue order, then a final "No
 * milestone" section. A row is marked new when a live allocation gave it to
 * this user within `newBadgeDays` and it is still theirs. Totals count
 * issues, except `overdue`, which counts overdue milestones. A milestone
 * in an inactive project (§2.8) is never "this week" and never counted
 * overdue: its date is not a deadline while the project is paused, so it
 * stays listed (as a later section) without making the week loud.
 */
export function buildWeekView(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  userId: string;
  recentAllocations: readonly RecentAllocation[];
}): WeekView {
  const { snapshot, ctx, assessments, userId } = input;
  const recent = recentAllocationsFor(
    input.recentAllocations,
    userId,
    ctx.now,
    ctx.tuning.newBadgeDays
  );

  const byMilestone = new Map<string, Issue[]>();
  const noMilestone: Issue[] = [];
  for (const issue of snapshot.issuesByAssignee.get(userId) ?? []) {
    if (!isOpenState(issueStateType(snapshot, issue))) continue;
    const milestone =
      issue.milestoneId === null
        ? undefined
        : snapshot.milestones.get(issue.milestoneId);
    if (milestone === undefined) {
      noMilestone.push(issue);
      continue;
    }
    const list = byMilestone.get(milestone.id);
    if (list === undefined) byMilestone.set(milestone.id, [issue]);
    else list.push(issue);
  }

  const toRow = (issue: Issue): WeekIssueRow => {
    const state = snapshot.states.get(issue.stateId);
    const allocation = recent.get(issue.id);
    const allocatedProject =
      allocation === undefined
        ? undefined
        : (snapshot.projects.get(allocation.projectId) ??
          (issue.projectId === null
            ? undefined
            : snapshot.projects.get(issue.projectId)));
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      priority: issue.priority,
      stateName: state?.name ?? '',
      stateType: issueStateType(snapshot, issue),
      newBecauseLeadOf:
        allocation === undefined ? null : (allocatedProject?.name ?? ''),
    };
  };

  const milestones = [...byMilestone.keys()]
    .flatMap((id) => {
      const milestone = snapshot.milestones.get(id);
      return milestone === undefined ? [] : [milestone];
    })
    .sort(compareMilestones(snapshot, ctx, assessments));

  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const sections: WeekSection[] = milestones.map((milestone) => {
    const assessment = assessments.get(milestone.id);
    const project = snapshot.projects.get(milestone.projectId);
    const daysLeft = assessment?.daysLeft ?? null;
    const status = assessment?.status ?? null;
    // A milestone whose project is missing from the mirror keeps its date.
    const active =
      project === undefined || activeStatuses.has(project.statusType);
    return {
      milestoneId: milestone.id,
      milestoneName: milestone.name,
      projectId: milestone.projectId,
      projectName: project?.name ?? null,
      projectUrl: project?.url ?? null,
      targetDate: milestoneTargetDate(milestone),
      daysLeft,
      status,
      progress: assessment?.progress ?? null,
      thisWeek:
        active &&
        (status === 'overdue' ||
          (daysLeft !== null && daysLeft <= THIS_WEEK_DAYS)),
      rows: (byMilestone.get(milestone.id) ?? [])
        .sort(compareIssues)
        .map(toRow),
    };
  });
  if (noMilestone.length > 0) {
    sections.push({
      milestoneId: null,
      milestoneName: null,
      projectId: null,
      projectName: null,
      projectUrl: null,
      targetDate: null,
      daysLeft: null,
      status: null,
      progress: null,
      thisWeek: false,
      rows: noMilestone.sort(compareIssues).map(toRow),
    });
  }

  // open, thisWeek and new count the user's issues; overdue counts the
  // overdue milestones they have open issues in (§8.4: "Overdue milestones",
  // "1 milestone overdue"), in active projects only: an overdue section is
  // this week exactly when its project is active.
  const totals = { open: 0, thisWeek: 0, overdue: 0, new: 0 };
  for (const section of sections) {
    totals.open += section.rows.length;
    if (section.thisWeek) totals.thisWeek += section.rows.length;
    if (section.status === 'overdue' && section.thisWeek) totals.overdue += 1;
    for (const row of section.rows) {
      if (row.newBecauseLeadOf !== null) totals.new += 1;
    }
  }

  return {
    userId,
    userName: snapshot.users.get(userId)?.name ?? '',
    today: ctx.today,
    sections,
    totals,
  };
}

// One timeline bar. `start` is the previous dated milestone's date, else the
// project's start date, else the window start, and never after `end`.
function toBar(
  milestone: Milestone,
  ctx: EvalContext,
  assessment: MilestoneAssessment | undefined,
  start: IsoDate
): TimelineBar {
  const end = milestoneTargetDate(milestone);
  return {
    milestoneId: milestone.id,
    name: milestone.name,
    projectId: milestone.projectId,
    start: end !== null && start > end ? end : start,
    end,
    status: assessment?.status ?? 'empty',
    reasons: assessment?.reasons ?? [],
    rubric: assessment?.rubric ?? { valid: false, gaps: [] },
    doneMeans: assessment?.doneMeans ?? { text: null, source: null },
    progress: assessment?.progress ?? EMPTY_PROGRESS,
    isNext: assessment?.isNext ?? false,
    daysLeft: assessment?.daysLeft ?? null,
    weight: ctx.meta.get(milestone.id)?.weight ?? null,
  };
}

/**
 * The timeline (§7.2): a window from `timelineDaysBack` before today to
 * `timelineDaysAhead` after, lanes for projects that are not completed or
 * canceled grouped by initiative ("No initiative" last), one bar per
 * milestone, and the banners that make missing inputs loud. Banners list
 * active projects only (§2.8: an inactive project is never loud).
 */
export function buildTimelineView(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
}): TimelineView {
  const { snapshot, ctx, assessments, allocationPlan } = input;
  const windowStart = addDays(ctx.today, -ctx.tuning.timelineDaysBack);
  const windowEnd = addDays(ctx.today, ctx.tuning.timelineDaysAhead);
  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const planByProject = new Map(
    allocationPlan.projects.map((plan) => [plan.projectId, plan])
  );

  const banners: TimelineView['banners'] = {
    projectsWithoutLead: [],
    milestonesWithoutDate: [],
    issuesWithoutMilestone: { count: 0, byProject: [] },
    blockedProjects: [],
  };

  const toLane = (project: Project): TimelineLane => {
    const lead =
      project.leadId === null ? undefined : snapshot.users.get(project.leadId);
    // Inactive projects (§2.8) keep their lane, drawn quietly, but never
    // appear in a banner: nothing in them is allocated or warned about.
    const active = activeStatuses.has(project.statusType);
    const bars: TimelineBar[] = [];
    const undated: TimelineBar[] = [];
    // A malformed project start is ignored, like a malformed milestone date.
    const projectStart =
      project.startDate !== null && isValidIsoDate(project.startDate)
        ? project.startDate
        : null;
    let previousDate: IsoDate | null = null;
    for (const milestone of snapshot.milestonesByProject.get(project.id) ??
      []) {
      const assessment = assessments.get(milestone.id);
      const end = milestoneTargetDate(milestone);
      if (end === null) {
        // Undated bars have no previous-date anchor; they start where the
        // project (or the window) does.
        undated.push(
          toBar(milestone, ctx, assessment, projectStart ?? windowStart)
        );
        if (active) {
          banners.milestonesWithoutDate.push({
            milestoneId: milestone.id,
            name: milestone.name,
            projectId: project.id,
            projectName: project.name,
          });
        }
      } else {
        const start = previousDate ?? projectStart ?? windowStart;
        bars.push(toBar(milestone, ctx, assessment, start));
        previousDate = end;
      }
    }

    // An issue whose milestone is not mirrored is as unplanned as one with
    // no milestone at all.
    const unplannedIssueIds = (snapshot.issuesByProject.get(project.id) ?? [])
      .filter(
        (issue) =>
          isOpenState(issueStateType(snapshot, issue)) &&
          (issue.milestoneId === null ||
            !snapshot.milestones.has(issue.milestoneId))
      )
      .sort(compareIssues)
      .map((issue) => issue.id);
    if (active && unplannedIssueIds.length > 0) {
      banners.issuesWithoutMilestone.count += unplannedIssueIds.length;
      banners.issuesWithoutMilestone.byProject.push({
        projectId: project.id,
        name: project.name,
        issueIds: unplannedIssueIds,
      });
    }

    if (active && project.leadId === null) {
      banners.projectsWithoutLead.push({
        projectId: project.id,
        name: project.name,
      });
    }
    const allocation = planByProject.get(project.id) ?? null;
    if (allocation?.outcome === 'blocked' && allocation.blockReason !== null) {
      banners.blockedProjects.push({
        projectId: project.id,
        name: project.name,
        reason: allocation.blockReason,
        gaps: [...allocation.gaps],
      });
    }

    return {
      projectId: project.id,
      name: project.name,
      url: project.url,
      leadId: project.leadId,
      leadName: lead?.name ?? null,
      priority: project.priority,
      statusType: project.statusType,
      active,
      bars,
      undated,
      unplannedIssueIds,
      allocation,
    };
  };

  const groups: TimelineGroup[] = [];
  for (const group of groupProjectsByInitiative(snapshot)) {
    const lanes = group.projects
      .filter(
        (project) =>
          project.statusType !== 'completed' &&
          project.statusType !== 'canceled'
      )
      .map(toLane);
    if (lanes.length === 0) continue;
    groups.push({
      initiativeId: group.initiative?.id ?? null,
      name: group.initiative?.name ?? 'No initiative',
      lanes,
    });
  }

  return { today: ctx.today, windowStart, windowEnd, groups, banners };
}

/**
 * The milestone drawer: the milestone, its project and assessment, its
 * issues (open first, each group in issue order) with their open blockers,
 * and the milestones it waits on (an open issue here blocked by an open
 * issue there). Null when the milestone, its project or its assessment is
 * missing.
 */
export function buildMilestoneDetail(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  milestoneId: string;
}): MilestoneDetail | null {
  const { snapshot, ctx, assessments, milestoneId } = input;
  const milestone = snapshot.milestones.get(milestoneId);
  if (milestone === undefined) return null;
  const project = snapshot.projects.get(milestone.projectId);
  const assessment = assessments.get(milestoneId);
  if (project === undefined || assessment === undefined) return null;

  const isOpen = (issue: Issue): boolean =>
    isOpenState(issueStateType(snapshot, issue));
  const issues = [...(snapshot.issuesByMilestone.get(milestoneId) ?? [])].sort(
    (a, b) => {
      const byOpen = Number(isOpen(b)) - Number(isOpen(a));
      return byOpen !== 0 ? byOpen : compareIssues(a, b);
    }
  );

  const waitsOn = new Map<string, Milestone>();
  const rows: MilestoneIssueRow[] = issues.map((issue) => {
    const open = isOpen(issue);
    const blockedByIds: string[] = [];
    for (const blockerId of snapshot.blockersOf.get(issue.id) ?? []) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined || !isOpen(blocker)) continue;
      blockedByIds.push(blockerId);
      if (
        !open ||
        blocker.milestoneId === null ||
        blocker.milestoneId === milestoneId
      ) {
        continue;
      }
      const other = snapshot.milestones.get(blocker.milestoneId);
      if (other !== undefined) waitsOn.set(other.id, other);
    }
    const assignee =
      issue.assigneeId === null
        ? undefined
        : snapshot.users.get(issue.assigneeId);
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      priority: issue.priority,
      stateName: snapshot.states.get(issue.stateId)?.name ?? '',
      stateType: issueStateType(snapshot, issue),
      assigneeId: issue.assigneeId,
      assigneeName: assignee?.name ?? null,
      blockedByIds,
    };
  });

  return {
    milestone,
    project,
    leadName:
      project.leadId === null
        ? null
        : (snapshot.users.get(project.leadId)?.name ?? null),
    assessment,
    meta: ctx.meta.get(milestoneId) ?? null,
    issues: rows,
    waitsOn: [...waitsOn.values()]
      .sort(compareMilestones(snapshot, ctx, assessments))
      .map((other) => ({
        milestoneId: other.id,
        name: other.name,
        projectName: snapshot.projects.get(other.projectId)?.name ?? '',
      })),
  };
}
