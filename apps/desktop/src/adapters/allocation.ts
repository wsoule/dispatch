import type {
  AllocationItemOutcome,
  AllocationRun,
  AllocationRunInput,
  AllocationRunItem,
  AllocationRunMode,
  AllocationRunProject,
  AllocationRunSummary,
} from '@dispatch/client';
import type {
  AllocationAction,
  AllocationPlan,
  ProjectAllocationOutcome,
  RecentAllocation,
  Snapshot,
} from '@dispatch/planning';
import type { UiTone } from '@dispatch/ui';

import { taskHref } from '../lib/routes';
import { formatDate, plural } from './planningFormat';
import { blockedReasonLine } from './planningStatus';

// The Allocation page (Better Tracker's /runs, ported): the planning's
// allocation plan as a preview (each unassigned issue in a project's next
// milestone, the lead it goes to, the status it moves to), the run record the
// daemon keeps when someone previews or applies it, and the run log. Pure
// functions over the planning and the recorded runs.

/** What a project's plan comes to, in a word, with its tone. */
const OUTCOME_WORDS: Record<
  ProjectAllocationOutcome,
  { label: string; tone: UiTone }
> = {
  allocate: { label: 'Allocating', tone: 'info' },
  nothing_to_do: { label: 'Nothing to do', tone: 'default' },
  blocked: { label: 'Blocked', tone: 'warning' },
  no_open_milestone: { label: 'No open milestone', tone: 'muted' },
  inactive: { label: 'Inactive', tone: 'muted' },
};

/** One issue the plan gives to a lead. */
interface AllocationPreviewItem {
  issueId: string;
  identifier: string;
  title: string;
  href: string;
  assigneeName: string;
  /** "Backlog → Todo", or the status it keeps. */
  statusChange: string;
}

/** One project in the preview: what its plan comes to and its items. */
export interface AllocationPreviewProject {
  projectId: string;
  projectName: string;
  outcome: ProjectAllocationOutcome;
  outcomeLabel: string;
  tone: UiTone;
  /** Why it is blocked; the next milestone otherwise; null when neither. */
  detail: string | null;
  items: AllocationPreviewItem[];
  skipped: number;
}

export interface AllocationPreview {
  /** Projects with something to say (allocating or blocked) first. */
  projects: AllocationPreviewProject[];
  actions: number;
  blocked: number;
  skipped: number;
  /** "3 issues to assign in 2 projects · 1 project blocked". */
  receipts: string;
}

function nameOf(snapshot: Snapshot, id: string): string {
  return snapshot.users.get(id)?.name ?? id;
}

function statusName(snapshot: Snapshot, id: string): string {
  return snapshot.states.get(id)?.name ?? id;
}

function nextMilestoneLine(
  snapshot: Snapshot,
  milestoneId: string | null,
  today: string
): string | null {
  if (milestoneId === null) return null;
  const milestone = snapshot.milestones.get(milestoneId);
  if (milestone === undefined) return null;
  const date = milestone.targetDate;
  return date === null
    ? `Next: ${milestone.name}`
    : `Next: ${milestone.name}, due ${formatDate(date, today)}`;
}

/** Projects with work or a block first, then the rest, in plan order. */
function rank(outcome: ProjectAllocationOutcome): number {
  if (outcome === 'allocate') return 0;
  if (outcome === 'blocked') return 1;
  return 2;
}

/** The plan as the preview draws it. */
export function buildAllocationPreview(
  plan: AllocationPlan,
  snapshot: Snapshot
): AllocationPreview {
  const projects = plan.projects
    .map((project): AllocationPreviewProject => {
      const words = OUTCOME_WORDS[project.outcome];
      return {
        projectId: project.projectId,
        projectName:
          snapshot.projects.get(project.projectId)?.name ?? project.projectId,
        outcome: project.outcome,
        outcomeLabel:
          project.outcome === 'allocate'
            ? `${words.label} ${project.actions.length}`
            : words.label,
        tone: words.tone,
        detail:
          project.outcome === 'blocked' && project.blockReason !== null
            ? blockedReasonLine(project.blockReason, project.gaps)
            : nextMilestoneLine(snapshot, project.nextMilestoneId, plan.today),
        items: project.actions.map((action) => ({
          issueId: action.issueId,
          identifier: action.identifier,
          title: action.title,
          href: taskHref(action.issueId),
          assigneeName: nameOf(snapshot, action.assigneeId),
          statusChange:
            action.toStateId === null
              ? statusName(snapshot, action.fromStateId)
              : `${statusName(snapshot, action.fromStateId)} → ${statusName(snapshot, action.toStateId)}`,
        })),
        skipped: project.skipped.length,
      };
    })
    .sort((a, b) => rank(a.outcome) - rank(b.outcome));

  const { actions, blockedProjects, skippedIssues } = plan.totals;
  const allocating = projects.filter((p) => p.outcome === 'allocate').length;
  const parts = [
    actions === 0
      ? 'Nothing to assign'
      : `${plural(actions, 'issue')} to assign in ${plural(allocating, 'project')}`,
  ];
  if (blockedProjects > 0) {
    parts.push(`${plural(blockedProjects, 'project')} blocked`);
  }
  return {
    projects,
    actions,
    blocked: blockedProjects,
    skipped: skippedIssues,
    receipts: parts.join(' · '),
  };
}

/** One action as the run log records it, with how it went. */
function toRunItem(
  action: AllocationAction,
  snapshot: Snapshot,
  outcome: AllocationItemOutcome,
  note: string | null
): AllocationRunItem {
  return {
    issueId: action.issueId,
    identifier: action.identifier,
    title: action.title,
    projectId: action.projectId,
    projectName:
      snapshot.projects.get(action.projectId)?.name ?? action.projectId,
    milestoneId: action.milestoneId,
    milestoneName:
      snapshot.milestones.get(action.milestoneId)?.name ?? action.milestoneId,
    assigneeId: action.assigneeId,
    assigneeName: nameOf(snapshot, action.assigneeId),
    fromStatus: action.fromStateId,
    toStatus: action.toStateId,
    outcome,
    note,
  };
}

/**
 * The run to record: every action with its outcome (a dry run: all "would
 * assign"; applied: what each update did, from `results`, by issue id, where
 * a string is the failure message) and every project's verdict.
 */
export function buildRunInput(
  plan: AllocationPlan,
  snapshot: Snapshot,
  mode: AllocationRunMode,
  results: ReadonlyMap<string, true | string> = new Map()
): AllocationRunInput {
  const items: AllocationRunItem[] = [];
  const projects: AllocationRunProject[] = [];
  for (const project of plan.projects) {
    for (const action of project.actions) {
      if (mode === 'dry_run') {
        items.push(toRunItem(action, snapshot, 'would_assign', null));
        continue;
      }
      const result = results.get(action.issueId);
      if (result === undefined) continue;
      items.push(
        result === true
          ? toRunItem(action, snapshot, 'assigned', null)
          : toRunItem(action, snapshot, 'failed', result)
      );
    }
    projects.push({
      projectId: project.projectId,
      projectName:
        snapshot.projects.get(project.projectId)?.name ?? project.projectId,
      outcome: project.outcome,
      reason:
        project.outcome === 'blocked' && project.blockReason !== null
          ? blockedReasonLine(project.blockReason, project.gaps)
          : null,
      skipped: project.skipped.length,
    });
  }
  return { mode, items, projects };
}

/** The comment an applied allocation leaves on the issue. */
export function allocationNote(
  action: AllocationAction,
  snapshot: Snapshot
): string {
  const project =
    snapshot.projects.get(action.projectId)?.name ?? 'the project';
  const milestone = snapshot.milestones.get(action.milestoneId);
  const due =
    milestone?.targetDate === null || milestone === undefined
      ? ''
      : `, due ${formatDate(milestone.targetDate)}`;
  return `Assigned by allocation: you lead ${project} and this is in its next milestone ${milestone?.name ?? ''}${due}.`;
}

/** One row of the run log. */
export interface AllocationRunRow {
  id: string;
  at: string;
  by: string;
  mode: AllocationRunMode;
  modeLabel: string;
  modeTone: UiTone;
  /** "2 assigned · 1 failed", "3 would assign", "Nothing to assign". */
  summary: string;
  blocked: number;
}

/** A recorded run as a log row. */
export function runRow(
  run: AllocationRunSummary,
  nameFor: (ref: string) => string
): AllocationRunRow {
  const { counts } = run;
  const parts: string[] = [];
  if (counts.assigned > 0) parts.push(`${counts.assigned} assigned`);
  if (counts.wouldAssign > 0) parts.push(`${counts.wouldAssign} would assign`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return {
    id: run.id,
    at: run.at,
    by: nameFor(run.by),
    mode: run.mode,
    modeLabel:
      run.mode === 'dry_run'
        ? 'Dry run'
        : run.trigger === 'daily'
          ? 'Daily'
          : 'Applied',
    modeTone: run.mode === 'applied' ? 'success' : 'default',
    summary: parts.length === 0 ? 'Nothing to assign' : parts.join(' · '),
    blocked: counts.blocked,
  };
}

/** Applied items as the planning's recent allocations (My week's "New"). */
export function recentAllocationsFrom(
  runs: readonly AllocationRun[]
): RecentAllocation[] {
  return runs.flatMap((run) =>
    run.mode !== 'applied'
      ? []
      : run.items
          .filter((item) => item.outcome === 'assigned')
          .map((item) => ({
            issueId: item.issueId,
            assigneeId: item.assigneeId,
            projectId: item.projectId,
            milestoneId: item.milestoneId,
            at: run.at,
          }))
  );
}
