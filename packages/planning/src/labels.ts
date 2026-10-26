// Shared human copy for the UI and the digests. Plain and concrete: say what
// is missing or what happened, never how bad it is.

import type {
  AllocationBlockReason,
  IssueListGroupBy,
  IssueListPresetId,
  IssueListQuick,
  IssueListSectionBy,
  IssueListSectionValue,
  IssueListSort,
  IssuePatchField,
  IssueSkipReason,
  MilestoneStatus,
  NoticeKind,
  Priority,
  RiskReason,
  RubricGap,
  WorkflowStateType,
} from './types';

/** What a rubric gap means, as a standalone line ("Missing a target date"). */
export const RUBRIC_GAP_LABEL: Record<RubricGap, string> = {
  no_target_date: 'Missing a target date',
  no_done_means: 'Missing "done means…"',
  no_project_lead: 'Project has no lead',
  no_issues: 'No issues yet',
};

/** The missing item alone, for lists such as "missing: done means…". */
export const RUBRIC_GAP_SHORT_LABEL: Record<RubricGap, string> = {
  no_target_date: 'target date',
  no_done_means: 'done means…',
  no_project_lead: 'project lead',
  no_issues: 'issues',
};

export const RISK_REASON_LABEL: Record<RiskReason, string> = {
  unassigned_open: 'Open issues unassigned',
  stalled: 'No recent state change',
  behind_pace: 'More work left than time left',
};

export const STATUS_LABEL: Record<MilestoneStatus, string> = {
  empty: 'No issues yet',
  complete: 'Complete',
  unscheduled: 'No target date',
  overdue: 'Overdue',
  at_risk: 'At risk',
  on_track: 'On track',
};

export const BLOCK_REASON_LABEL: Record<AllocationBlockReason, string> = {
  no_lead: 'Project has no lead',
  lead_inactive: 'Project lead is deactivated',
  next_milestone_invalid: 'Next milestone is missing required details',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

/** An issue field as the issue page and the audit log name it. */
export const ISSUE_FIELD_LABEL: Record<IssuePatchField, string> = {
  title: 'Title',
  description: 'Description',
  stateId: 'Status',
  assigneeId: 'Assignee',
  priority: 'Priority',
  projectId: 'Project',
  projectMilestoneId: 'Milestone',
  dueDate: 'Due date',
  estimate: 'Estimate',
  labelIds: 'Labels',
};

export const ISSUE_SKIP_REASON_LABEL: Record<IssueSkipReason, string> = {
  already_assigned: 'Already assigned',
  triage: 'Still in Triage',
};

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  overdue: 'Overdue',
  at_risk: 'At risk',
  invalid_due_soon: 'Due soon, missing required details',
  allocation_blocked: 'Allocation stopped',
};

/** A workflow state type as the issue list's Status filter names it. */
export const STATE_TYPE_LABEL: Record<WorkflowStateType, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Todo',
  started: 'In progress',
  completed: 'Done',
  canceled: 'Canceled',
};

/** The issue list's Group menu. */
export const ISSUE_LIST_GROUP_LABEL: Record<IssueListGroupBy, string> = {
  milestone: 'Milestone',
  project: 'Project',
  initiative: 'Initiative',
  assignee: 'Assignee',
  state: 'Status',
  priority: 'Priority',
  none: 'None',
};

/** The issue list's sections ("Group: Milestone · by initiative"). */
export const ISSUE_LIST_SECTION_LABEL: Record<IssueListSectionBy, string> = {
  none: 'None',
  initiative: 'Initiative',
  project: 'Project',
};

/** The issue list's Sort menu. */
export const ISSUE_LIST_SORT_LABEL: Record<IssueListSort, string> = {
  weight: 'Weight',
  priority: 'Priority',
  due: 'Due date',
  updated: 'Last updated',
  created: 'Created',
  title: 'Title',
};

/** What each sort means, as the Sort menu hints it. */
export const ISSUE_LIST_SORT_HINT: Record<IssueListSort, string> = {
  weight:
    'Overdue milestones first, then weight, due date and project priority; inside a milestone, priority then oldest.',
  priority: 'Urgent first',
  due: "The issue's own due date, soonest first",
  updated: 'Newest first',
  created: 'Newest first',
  title: 'A to Z',
};

/** The issue list's quick filters. */
export const ISSUE_LIST_QUICK_LABEL: Record<IssueListQuick, string> = {
  blocked: 'Blocked',
  at_risk: 'At risk',
  next: 'In next milestones',
};

/** The tier dividers of the default issue list (group by milestone). */
export const ISSUE_LIST_TIER_LABEL: Record<
  Extract<IssueListSectionValue, { kind: 'tier' }>['tier'],
  string
> = {
  overdue: 'Overdue',
  upcoming: 'Upcoming',
  unplanned: 'No milestone',
  inactive: 'Inactive projects',
};

/** The issue list's preset tabs. */
export const ISSUE_LIST_PRESET_LABEL: Record<IssueListPresetId, string> = {
  all: 'All',
  mine: 'Mine',
  unplanned: 'Unplanned',
  unassigned: 'Unassigned',
  blocked: 'Blocked',
  at_risk: 'At risk',
};

/** `1 issue`, `2 issues`: the count followed by the right noun form. */
export function countLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "2 open issues unassigned" (§2.9 digest line). */
export function unassignedLine(count: number): string {
  return `${countLabel(count, 'open issue')} unassigned`;
}

/** "no state change in 9 days" (§2.9 digest line). */
export function stalledLine(days: number): string {
  return `no state change in ${countLabel(days, 'day')}`;
}

/**
 * Days left as words: "2 days left", "due today", "3 days overdue". Null
 * (no target date) reads "no target date".
 */
export function daysLeftLabel(daysLeft: number | null): string {
  if (daysLeft === null) return 'no target date';
  if (daysLeft === 0) return 'due today';
  if (daysLeft > 0) return `${countLabel(daysLeft, 'day')} left`;
  return `${countLabel(-daysLeft, 'day')} overdue`;
}

/** "2/7 done with 2 days left", "2/7 done, due today", "2/7 done, 3 days overdue". */
export function paceLine(
  completed: number,
  scope: number,
  daysLeft: number
): string {
  const done = `${completed}/${scope} done`;
  return daysLeft > 0
    ? `${done} with ${daysLeftLabel(daysLeft)}`
    : `${done}, ${daysLeftLabel(daysLeft)}`;
}

/** "missing: done means…, project lead" for a list of rubric gaps. */
export function missingLine(gaps: readonly RubricGap[]): string {
  return `missing: ${gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ')}`;
}
