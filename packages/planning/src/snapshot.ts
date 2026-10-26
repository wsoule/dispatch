// Indexing of the mirrored workspace. indexWorkspace runs once per load and
// builds every lookup the rules need, so rule functions never scan the raw
// arrays.

import { isValidIsoDate } from './dates';
import type {
  IsoDate,
  Issue,
  Milestone,
  Priority,
  Snapshot,
  WorkflowStateType,
  WorkspaceData,
} from './types';

/** open = triage | backlog | unstarted | started (§2.1). */
export function isOpenState(type: WorkflowStateType): boolean {
  return (
    type === 'triage' ||
    type === 'backlog' ||
    type === 'unstarted' ||
    type === 'started'
  );
}

/** Sort rank of a Linear priority: urgent 1 … low 4, no priority 5 (last). */
export function priorityRank(p: Priority): number {
  return p === 0 ? 5 : p;
}

/**
 * A milestone's target date when it is a real calendar date, else null. A
 * malformed date is treated as missing, which the rubric then reports.
 */
export function milestoneTargetDate(m: Milestone): IsoDate | null {
  return m.targetDate !== null && isValidIsoDate(m.targetDate)
    ? m.targetDate
    : null;
}

/**
 * The workflow state category of an issue. An issue whose state is not
 * mirrored counts as `backlog` (open), the same fallback the Linear gateway
 * uses for unknown state types, so it stays visible instead of vanishing.
 */
export function issueStateType(
  snapshot: Snapshot,
  issue: Issue
): WorkflowStateType {
  return snapshot.states.get(issue.stateId)?.type ?? 'backlog';
}

/** True when the issue is in an open state category. */
export function isIssueOpen(snapshot: Snapshot, issue: Issue): boolean {
  return isOpenState(issueStateType(snapshot, issue));
}

// Milestone order inside a project (§2.6): target date ascending, undated
// last, then Linear's sortOrder, then id so the order is total.
function compareProjectMilestones(a: Milestone, b: Milestone): number {
  const da = milestoneTargetDate(a);
  const db = milestoneTargetDate(b);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Appends `value` to the list stored under `key`, creating the list on first
// use.
function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// Map from entity id to entity for one entity array.
function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * Indexes the mirror for evaluation. Issue lists keep the mirror's order
 * (sort with compareIssues where order matters); milestonesByProject is in
 * §2.6 order. Every mirrored project and milestone gets an entry, empty when
 * it has nothing. Relations whose blocker or blocked issue is not mirrored
 * are ignored, and duplicate relations count once.
 */
export function indexWorkspace(data: WorkspaceData): Snapshot {
  const issues = byId(data.issues);

  const milestonesByProject = new Map<string, Milestone[]>();
  for (const project of data.projects) milestonesByProject.set(project.id, []);
  for (const milestone of data.milestones) {
    pushTo(milestonesByProject, milestone.projectId, milestone);
  }
  for (const list of milestonesByProject.values()) {
    list.sort(compareProjectMilestones);
  }

  const issuesByMilestone = new Map<string, Issue[]>();
  for (const milestone of data.milestones) {
    issuesByMilestone.set(milestone.id, []);
  }
  const issuesByProject = new Map<string, Issue[]>();
  for (const project of data.projects) issuesByProject.set(project.id, []);
  const issuesByAssignee = new Map<string, Issue[]>();
  for (const issue of data.issues) {
    if (issue.milestoneId !== null) {
      pushTo(issuesByMilestone, issue.milestoneId, issue);
    }
    if (issue.projectId !== null) {
      pushTo(issuesByProject, issue.projectId, issue);
    }
    if (issue.assigneeId !== null) {
      pushTo(issuesByAssignee, issue.assigneeId, issue);
    }
  }

  const blockersOf = new Map<string, string[]>();
  const blocking = new Map<string, string[]>();
  const seenPairs = new Set<string>();
  for (const relation of data.relations) {
    if (!issues.has(relation.blockerId) || !issues.has(relation.blockedId)) {
      continue;
    }
    const pair = `${relation.blockerId}\u0000${relation.blockedId}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    pushTo(blockersOf, relation.blockedId, relation.blockerId);
    pushTo(blocking, relation.blockerId, relation.blockedId);
  }

  return {
    data,
    users: byId(data.users),
    teams: byId(data.teams),
    states: byId(data.states),
    initiatives: byId(data.initiatives),
    projects: byId(data.projects),
    milestones: byId(data.milestones),
    issues,
    milestonesByProject,
    issuesByMilestone,
    issuesByProject,
    issuesByAssignee,
    blockersOf,
    blocking,
  };
}

/**
 * The mirrored issue a URL names: its id, or its identifier in any case
 * ("ENG-24", "eng-24"). Undefined when the mirror has neither. One scan of
 * the issues when the key is not an id (the mirror has no identifier index).
 */
export function findIssue(
  issues: ReadonlyMap<string, Issue>,
  key: string
): Issue | undefined {
  const byId = issues.get(key);
  if (byId !== undefined) return byId;
  const wanted = key.toUpperCase();
  for (const issue of issues.values()) {
    if (issue.identifier.toUpperCase() === wanted) return issue;
  }
  return undefined;
}
