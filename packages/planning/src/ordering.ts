// Display ordering (§2.7): milestones, issues, and the timeline's project
// order. Weight overrides live here and nowhere else (§6.13).

import { milestoneTargetDate, priorityRank } from './snapshot';
import type {
  EvalContext,
  Initiative,
  Issue,
  Milestone,
  MilestoneAssessment,
  Priority,
  Project,
  Snapshot,
} from './types';

// Plain code-unit comparison: deterministic on every host, unlike
// localeCompare.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Orders Linear identifiers like `ENG-2` before `ENG-10`: team key first,
// then the number numerically; anything else falls back to plain order.
function compareIdentifiers(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma !== null && mb !== null) {
    const prefix = compareStrings(ma[1] ?? '', mb[1] ?? '');
    if (prefix !== 0) return prefix;
    const diff = Number(ma[2]) - Number(mb[2]);
    if (diff !== 0) return diff;
  }
  return compareStrings(a, b);
}

// Dates as `YYYY-MM-DD` sort correctly as strings; null (undated) goes last.
function compareDatesUndatedLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

// Shared order for initiatives and projects: priority rank (none last), then
// Linear's manual sortOrder, then id.
function compareRankThenSortOrder(
  a: { id: string; priority: Priority; sortOrder: number },
  b: { id: string; priority: Priority; sortOrder: number }
): number {
  const byRank = priorityRank(a.priority) - priorityRank(b.priority);
  if (byRank !== 0) return byRank;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return compareStrings(a.id, b.id);
}

/**
 * Milestone display order (§2.7): overdue first; then higher weight (null =
 * 0); target date ascending (undated last); project priority (none last);
 * milestone sortOrder; id.
 */
export function compareMilestones(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): (a: Milestone, b: Milestone) => number {
  const overdueRank = (m: Milestone): number =>
    assessments.get(m.id)?.status === 'overdue' ? 0 : 1;
  const weightOf = (m: Milestone): number => ctx.meta.get(m.id)?.weight ?? 0;
  const projectRank = (m: Milestone): number => {
    const project = snapshot.projects.get(m.projectId);
    return project === undefined ? 6 : priorityRank(project.priority);
  };
  return (a, b) => {
    const byOverdue = overdueRank(a) - overdueRank(b);
    if (byOverdue !== 0) return byOverdue;
    const byWeight = weightOf(b) - weightOf(a);
    if (byWeight !== 0) return byWeight;
    const byDate = compareDatesUndatedLast(
      milestoneTargetDate(a),
      milestoneTargetDate(b)
    );
    if (byDate !== 0) return byDate;
    const byProject = projectRank(a) - projectRank(b);
    if (byProject !== 0) return byProject;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return compareStrings(a.id, b.id);
  };
}

/**
 * Issue order inside a milestone (§2.7): priority (none last), then oldest
 * first, then identifier (`ENG-2` before `ENG-10`), then id.
 */
export function compareIssues(a: Issue, b: Issue): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  const ca = Date.parse(a.createdAt);
  const cb = Date.parse(b.createdAt);
  if (!Number.isNaN(ca) && !Number.isNaN(cb) && ca !== cb) return ca - cb;
  const byIdentifier = compareIdentifiers(a.identifier, b.identifier);
  if (byIdentifier !== 0) return byIdentifier;
  return compareStrings(a.id, b.id);
}

/** Initiative order on the timeline: priority rank (none last), sortOrder, id. */
export function compareInitiatives(a: Initiative, b: Initiative): number {
  return compareRankThenSortOrder(a, b);
}

/** Lane order inside a timeline group: priority rank (none last), sortOrder, id. */
export function compareProjects(a: Project, b: Project): number {
  return compareRankThenSortOrder(a, b);
}

/**
 * The id of the "No initiative" group, graph node and graph container (the
 * timeline's ?initiative=none). Linear ids are UUIDs, so it cannot clash.
 */
export const NO_INITIATIVE_ID = 'none';

/**
 * Each mirrored project's first initiative: the best-ranked of its mirrored
 * initiatives in compareInitiatives order; null when it has none. This is
 * the timeline's grouping rule (§2.11), shared so the graph and the timeline
 * cannot disagree. Unmirrored initiative ids are ignored. O(project links).
 */
export function homeInitiativeIds(
  snapshot: Snapshot
): ReadonlyMap<string, string | null> {
  const rankOf = new Map<string, number>();
  [...snapshot.data.initiatives]
    .sort(compareInitiatives)
    .forEach((initiative, index) => rankOf.set(initiative.id, index));
  const home = new Map<string, string | null>();
  for (const project of snapshot.data.projects) {
    let best: string | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const id of project.initiativeIds) {
      const rank = rankOf.get(id);
      if (rank !== undefined && rank < bestRank) {
        best = id;
        bestRank = rank;
      }
    }
    home.set(project.id, best);
  }
  return home;
}

/**
 * Projects grouped the way the timeline shows them (§2.11): initiatives in
 * order, each project under the first of its initiatives in that order
 * (homeInitiativeIds; unmirrored initiative ids are ignored), then a final
 * `initiative: null` group. Includes every project, whatever its status;
 * empty groups are left out.
 */
export function groupProjectsByInitiative(
  snapshot: Snapshot
): { initiative: Initiative | null; projects: Project[] }[] {
  const home = homeInitiativeIds(snapshot);
  const grouped = new Map<string | null, Project[]>();
  for (const project of snapshot.data.projects) {
    const best = home.get(project.id) ?? null;
    const list = grouped.get(best);
    if (list === undefined) grouped.set(best, [project]);
    else list.push(project);
  }

  const groups: { initiative: Initiative | null; projects: Project[] }[] = [];
  for (const initiative of [...snapshot.data.initiatives].sort(
    compareInitiatives
  )) {
    const projects = grouped.get(initiative.id);
    if (projects !== undefined) {
      groups.push({ initiative, projects: projects.sort(compareProjects) });
    }
  }
  const ungrouped = grouped.get(null);
  if (ungrouped !== undefined) {
    groups.push({
      initiative: null,
      projects: ungrouped.sort(compareProjects),
    });
  }
  return groups;
}

/** Every project in timeline order (initiative group, then lane order). */
export function orderProjects(snapshot: Snapshot): Project[] {
  return groupProjectsByInitiative(snapshot).flatMap((group) => group.projects);
}
