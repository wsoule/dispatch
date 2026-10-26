// The allocation plan (§2.8): which unassigned issues go to which project
// lead, and why other projects get nothing. Pure planning only; the engine
// applies the actions.

import { nextMilestoneId } from './assess';
import { formatDisplayDate } from './dates';
import { compareIssues, orderProjects } from './ordering';
import { evaluateRubric } from './rubric';
import { isOpenState, issueStateType } from './snapshot';
import type {
  AllocationAction,
  AllocationPlan,
  AllocationSkip,
  EvalContext,
  IsoDate,
  MilestoneAssessment,
  Project,
  ProjectAllocationPlan,
  RubricResult,
  Snapshot,
  WorkflowState,
} from './types';

/**
 * The state allocation moves a Backlog issue to: the team's `unstarted`
 * state named "Todo" (any case), else its lowest-position `unstarted` state,
 * else null (the issue keeps its state).
 */
export function resolveTodoState(
  snapshot: Snapshot,
  teamId: string
): WorkflowState | null {
  let named: WorkflowState | null = null;
  let lowest: WorkflowState | null = null;
  for (const state of snapshot.data.states) {
    if (state.teamId !== teamId || state.type !== 'unstarted') continue;
    if (lowest === null || isEarlierState(state, lowest)) lowest = state;
    if (
      state.name.trim().toLowerCase() === 'todo' &&
      (named === null || isEarlierState(state, named))
    ) {
      named = state;
    }
  }
  return named ?? lowest;
}

// Lower position first; id breaks ties so the choice is deterministic.
function isEarlierState(a: WorkflowState, b: WorkflowState): boolean {
  return a.position !== b.position ? a.position < b.position : a.id < b.id;
}

// A plan entry with nothing to do, for the early-exit outcomes.
function emptyPlan(
  projectId: string,
  outcome: ProjectAllocationPlan['outcome'],
  nextMilestoneId: string | null
): ProjectAllocationPlan {
  return {
    projectId,
    outcome,
    nextMilestoneId,
    blockReason: null,
    gaps: [],
    actions: [],
    skipped: [],
  };
}

// Plans one project by the §2.8 steps. `todoStateFor` is a per-run cache so
// each team's states are scanned once.
function planProject(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  project: Project,
  todoStateFor: (teamId: string) => WorkflowState | null
): ProjectAllocationPlan {
  const nextId = nextMilestoneId(snapshot, project.id, assessments);
  if (!ctx.tuning.activeProjectStatuses.includes(project.statusType)) {
    return emptyPlan(project.id, 'inactive', nextId);
  }

  // The lead comes before the next milestone (design §6.1: a project with
  // no lead is flagged everywhere, the warning digest included), so an
  // active project without a working lead is blocked even when it has no
  // open milestone (nextMilestoneId is then null).
  if (project.leadId === null) {
    return {
      ...emptyPlan(project.id, 'blocked', nextId),
      blockReason: 'no_lead',
    };
  }
  const lead = snapshot.users.get(project.leadId);
  if (lead === undefined || !lead.active) {
    return {
      ...emptyPlan(project.id, 'blocked', nextId),
      blockReason: 'lead_inactive',
    };
  }
  if (nextId === null) return emptyPlan(project.id, 'no_open_milestone', null);

  const rubric: RubricResult =
    assessments.get(nextId)?.rubric ??
    evaluateRubric(snapshot, nextId, ctx.meta.get(nextId));
  if (!rubric.valid) {
    // Never skip ahead to a later milestone (§6.11).
    return {
      ...emptyPlan(project.id, 'blocked', nextId),
      blockReason: 'next_milestone_invalid',
      gaps: [...rubric.gaps],
    };
  }

  const actions: AllocationAction[] = [];
  const skipped: AllocationSkip[] = [];
  const openIssues = (snapshot.issuesByMilestone.get(nextId) ?? [])
    .filter((issue) => isOpenState(issueStateType(snapshot, issue)))
    .sort(compareIssues);
  for (const issue of openIssues) {
    if (issue.assigneeId !== null) {
      skipped.push({
        issueId: issue.id,
        identifier: issue.identifier,
        reason: 'already_assigned',
      });
      continue;
    }
    const type = issueStateType(snapshot, issue);
    if (type === 'triage') {
      skipped.push({
        issueId: issue.id,
        identifier: issue.identifier,
        reason: 'triage',
      });
      continue;
    }
    actions.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      projectId: project.id,
      milestoneId: nextId,
      assigneeId: lead.id,
      fromStateId: issue.stateId,
      toStateId:
        type === 'backlog' ? (todoStateFor(issue.teamId)?.id ?? null) : null,
    });
  }

  return {
    ...emptyPlan(
      project.id,
      actions.length > 0 ? 'allocate' : 'nothing_to_do',
      nextId
    ),
    actions,
    skipped,
  };
}

/**
 * Plans allocation for every project in timeline order (§2.8): inactive
 * projects are left alone quietly; a missing lead, a deactivated lead or an
 * invalid next milestone blocks the project loudly; otherwise each open,
 * unassigned, non-Triage issue of the next milestone goes to the lead, and
 * Backlog issues move to the team's Todo state. Planning again after the
 * actions are applied yields no actions.
 */
export function planAllocation(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): AllocationPlan {
  const todoCache = new Map<string, WorkflowState | null>();
  const todoStateFor = (teamId: string): WorkflowState | null => {
    if (!todoCache.has(teamId)) {
      todoCache.set(teamId, resolveTodoState(snapshot, teamId));
    }
    return todoCache.get(teamId) ?? null;
  };

  const projects = orderProjects(snapshot).map((project) =>
    planProject(snapshot, ctx, assessments, project, todoStateFor)
  );
  let actions = 0;
  let blockedProjects = 0;
  let skippedIssues = 0;
  for (const plan of projects) {
    actions += plan.actions.length;
    skippedIssues += plan.skipped.length;
    if (plan.outcome === 'blocked') blockedProjects += 1;
  }
  return {
    today: ctx.today,
    projects,
    totals: { actions, blockedProjects, skippedIssues },
  };
}

/**
 * The Linear comment written with each allocation (§7.4), e.g.
 * `Assigned by Milestone Planner: you lead Orion and this is in its next
 * milestone Beta, due Oct 28, 2026.`
 */
export function allocationComment(input: {
  appName: string;
  projectName: string;
  milestoneName: string;
  targetDate: IsoDate;
}): string {
  return `Assigned by ${input.appName}: you lead ${input.projectName} and this is in its next milestone ${input.milestoneName}, due ${formatDisplayDate(input.targetDate)}.`;
}
