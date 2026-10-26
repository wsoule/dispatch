import type {
  Person,
  StatusModel,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import {
  canonicalKind,
  canonicalStatus,
  statusType,
} from '@dispatch-foo/core/browser';
import type { EpicProgress, LinearIssueLink, RunMeta } from '@dispatch/client';
import type {
  BlockingRelation,
  EvalContext,
  Initiative,
  Issue,
  Milestone,
  MilestoneMeta,
  Project,
  ProjectStatusType,
  Team,
  Tuning,
  User,
  WorkflowState,
  WorkflowStateType,
  WorkspaceData,
} from '@dispatch/planning';
import { DEFAULT_TUNING } from '@dispatch/planning';

import { resolveLinearLink } from '../lib/linearSettings';
import { dayFromNow } from '../lib/taskDates';
import { parseTaskSections, statusLabel } from '../lib/taskDisplay';
import { AGENT_POOL, AGENT_POOL_LABEL, agentChoiceId } from './people';
import { toTaskPriority } from './rows';

// Dispatch's task list → @dispatch/planning's WorkspaceData, the mirror the
// planning core (indexWorkspace, assessWorkspace, planAllocation, the
// timeline, the dependency graph) evaluates. The planning package was written
// against Linear's model; this adapter is the one place Dispatch's model is
// read in Linear's terms, so every approximation lives here:
//
// - One workspace ('dispatch') and one team (PLANNING_TEAM) that owns every
//   workflow state: a Dispatch project has one status vocabulary.
// - Workflow states are the status model's definitions (id = the status
//   name, type = its StatusType, which is exactly Linear's category). The
//   `unstarted` state planAllocation moves a Backlog issue to is whichever
//   unstarted status the config defines (`ready` by default); a config with
//   no unstarted status synthesizes none, and allocation then leaves each
//   issue's state as it is (AllocationAction.toStateId is null).
// - Users are the people registry plus the agents a task may name
//   (`agentChoiceId` per executor and the 'agent' pool), flagged `app`.
// - The hierarchy is `parent`: initiative → project → milestone → task →
//   sub-task. An issue's project and milestone are the nearest ones above it
//   (a sub-task inherits its parent issue's). A milestone with no project
//   above it (parented to an initiative, orphaned or under a parent the list
//   does not hold) goes under a synthetic "No project" lane per initiative
//   or root (`noProjectId`), created on demand; it is inactive (statusType
//   `backlog`) so it never raises a banner of its own.
// - Timing is approximate: Dispatch keeps no startedAt / completedAt /
//   lastStateChangeAt, so `updated` stands in for the state change (a
//   milestone reads "stalled" when none of its issues was touched for
//   `stallDays`), completedAt / canceledAt are `updated` when the status is
//   of that type, and startedAt is the task's latest run's start when it has
//   one. Read the timeline's risk reasons as approximate for that reason.
// - Blocking relations are the `blockedBy` edges between two issues in the
//   set. Edges that touch a container (a milestone blocked by a task, a task
//   blocked by a project) are dropped: the planning model has no container
//   relations, and the milestone-level graph derives its arrows from issue
//   edges anyway.
//
// Pure functions over plain data, unit-tested without React.

/** The one team every Dispatch project is: one workflow, one roster. */
export const PLANNING_TEAM_ID = 'dispatch';

/** The one workspace: every planning id is scoped to the open project. */
const WORKSPACE_ID = 'dispatch';

/** The synthetic lane for milestones with no project above them:
 * `project:none:<initiativeId>` under an initiative, `project:none:root`
 * at the top. Linear-shaped ids never start with `project:`. */
export function noProjectId(initiativeId: string | null): string {
  return `project:none:${initiativeId ?? 'root'}`;
}

/** Linear's project status for a Dispatch status type: not yet planned
 * (triage, backlog), planned (unstarted), started, finished. */
const PROJECT_STATUS: Readonly<Record<WorkflowStateType, ProjectStatusType>> = {
  triage: 'backlog',
  backlog: 'backlog',
  unstarted: 'planned',
  started: 'started',
  completed: 'completed',
  canceled: 'canceled',
};

export interface WorkspaceDataInput {
  /** Every task the window shows, containers included, archived excluded
   * (`DispatchProjectData.tasks`). */
  tasks: readonly TaskListItem[];
  /** The project's status model (`useStatusModelOf(config)`). */
  model: StatusModel;
  /** The people registry (`DispatchProjectData.people`). */
  people: readonly Person[];
  /** The daemon's executor names (`ExecutorsResponse.executors[].name`). */
  executors: readonly string[];
  /** This window's own `human:<handle>` ref, or null until the daemon says:
   * what an agent's ref is owned by (`agentChoiceId`). */
  me: string | null;
  /** `GET /api/linear/links`: issue UUID → identifier and URL, for the
   * identifier an issue is named by. */
  linearLinks?: Readonly<Record<string, LinearIssueLink>>;
  /** Each task's latest run: its start is the issue's startedAt. */
  latestRunByTaskId?: ReadonlyMap<string, Pick<RunMeta, 'createdAt'>>;
  /** Fan-out progress per container: a paused session pauses the project. */
  epicProgressById?: ReadonlyMap<string, Pick<EpicProgress, 'session'>>;
  /** Where a task opens (`taskHref`): the issue's and project's `url`. */
  hrefFor: (taskId: string) => string;
}

/** The containers above a task, nearest of each kind; null where none. */
interface Containers {
  initiativeId: string | null;
  projectId: string | null;
  milestoneId: string | null;
}

const NO_CONTAINERS: Containers = {
  initiativeId: null,
  projectId: null,
  milestoneId: null,
};

// `above` plus `node` itself, for the tasks under `node`: a container kind
// takes its slot (the nearest wins, since the walk folds from the top down),
// a task passes its parents' containers through to its sub-tasks.
function withContainer(above: Containers, node: TaskListItem): Containers {
  switch (canonicalKind(node.meta.kind)) {
    case 'initiative':
      return { ...above, initiativeId: node.meta.id };
    case 'project':
      return { ...above, projectId: node.meta.id };
    case 'milestone':
      return { ...above, milestoneId: node.meta.id };
    default:
      return above;
  }
}

/**
 * The containers above each task (exclusive of itself), the same walk
 * `containerHomes` in lib/listGrouping makes for the milestone grouping: up
 * through `parent` until the chain leaves the list or loops. A parent the
 * list does not hold (an archived milestone, a deleted project) ends the
 * walk with nothing above; a cycle too. Memoized along every chain it
 * walks, so the whole list costs O(tasks).
 */
function containersAbove(
  byId: ReadonlyMap<string, TaskListItem>
): (id: string) => Containers {
  const memo = new Map<string, Containers>();
  return (id) => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // Climb until a memoized ancestor, the top, an unknown id or a cycle.
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    let above: Containers = NO_CONTAINERS;
    while (cursor !== null) {
      const known = memo.get(cursor);
      if (known !== undefined) {
        // What is above the memoized ancestor, plus the ancestor itself.
        const node = byId.get(cursor);
        above = node === undefined ? known : withContainer(known, node);
        break;
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      chain.push(cursor);
      const node = byId.get(cursor);
      if (node === undefined) break;
      cursor = node.meta.parent;
    }
    // Fold back down: each link's containers are its parent's plus the
    // parent itself.
    for (let k = chain.length - 1; k >= 0; k--) {
      const link = chain[k];
      memo.set(link, above);
      const node = byId.get(link);
      if (node !== undefined) above = withContainer(above, node);
    }
    return memo.get(id) ?? NO_CONTAINERS;
  };
}

/** A stored day as the planning core's `YYYY-MM-DD`: the calendar part of an
 * ISO date or instant, or null when it is neither (the rubric then reports
 * the date as missing rather than reading garbage). */
function calendarDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** An assignee as the planning core's user id: null for nobody. */
function assigneeId(assignee: string | null | undefined): string | null {
  return assignee === null ||
    assignee === undefined ||
    assignee === '' ||
    assignee === 'none'
    ? null
    : assignee;
}

/** The body's `## Description` section, for the rubric's "Done means…" line;
 * '' for a list item (no body) or a body without one. */
function descriptionOf(doc: TaskListItem): string {
  if (!('body' in doc) || typeof doc.body !== 'string') return '';
  return parseTaskSections(doc.body).get('Description') ?? '';
}

/**
 * Dispatch's task list as the planning core's mirror of one workspace. One
 * pass over the tasks per entity kind plus the memoized hierarchy walk:
 * O(tasks + relations).
 */
export function buildWorkspaceData(input: WorkspaceDataInput): WorkspaceData {
  const { model, hrefFor } = input;
  const links = input.linearLinks ?? {};

  // People, then the agents a task may name. The pool is listed last.
  const users: User[] = input.people.map((person) => ({
    id: person.ref,
    name: person.name,
    displayName: person.name,
    email: person.email ?? null,
    avatarUrl: person.avatarUrl ?? null,
    active: true,
    app: false,
  }));
  for (const executor of input.executors) {
    users.push({
      id: agentChoiceId(input.me, executor),
      name: executor,
      displayName: executor,
      email: null,
      avatarUrl: null,
      active: true,
      app: true,
    });
  }
  users.push({
    id: AGENT_POOL,
    name: AGENT_POOL_LABEL,
    displayName: AGENT_POOL_LABEL,
    email: null,
    avatarUrl: null,
    active: true,
    app: true,
  });
  const userIds = new Set(users.map((user) => user.id));

  const team: Team = {
    id: PLANNING_TEAM_ID,
    key: 'DSP',
    name: 'Dispatch',
    visibility: 'public',
    parentId: null,
    memberIds: [...userIds],
  };

  // The configured statuses in board order, then any status a task carries
  // that the config leaves undefined, typed the way core reads it, so the
  // planning core never reads a status as backlog that Dispatch reads
  // otherwise.
  const states: WorkflowState[] = model.definitions.map((definition, i) => ({
    id: definition.name,
    teamId: PLANNING_TEAM_ID,
    name: statusLabel(definition.name),
    type: definition.type,
    position: i,
  }));
  const stateIds = new Set(states.map((state) => state.id));
  for (const doc of input.tasks) {
    const name = canonicalStatus(doc.meta.status);
    if (stateIds.has(name)) continue;
    stateIds.add(name);
    states.push({
      id: name,
      teamId: PLANNING_TEAM_ID,
      name: statusLabel(name),
      type: statusType(name, model),
      position: states.length,
    });
  }

  const byId = new Map<string, TaskListItem>();
  for (const doc of input.tasks) byId.set(doc.meta.id, doc);
  const above = containersAbove(byId);

  const initiatives: Initiative[] = [];
  const projects: Project[] = [];
  const milestones: Milestone[] = [];
  const issueDocs: TaskListItem[] = [];
  for (const doc of input.tasks) {
    const { meta } = doc;
    switch (canonicalKind(meta.kind)) {
      case 'initiative':
        initiatives.push({
          id: meta.id,
          name: meta.title,
          sortOrder: initiatives.length,
          priority: toTaskPriority(meta.priority),
          targetDate: calendarDate(meta.dueDate),
        });
        break;
      case 'project': {
        const type = statusType(meta.status, model);
        const base = PROJECT_STATUS[type];
        const session = input.epicProgressById?.get(meta.id)?.session;
        // A paused fan-out pauses an open project; finished stays finished.
        const paused =
          session?.state === 'paused' &&
          base !== 'completed' &&
          base !== 'canceled';
        const lead = assigneeId(meta.assignee);
        const home = above(meta.id).initiativeId;
        const initiativeIds: string[] = home === null ? [] : [home];
        for (const id of meta.initiatives) {
          if (!initiativeIds.includes(id)) initiativeIds.push(id);
        }
        projects.push({
          id: meta.id,
          name: meta.title,
          url: hrefFor(meta.id),
          leadId: lead !== null && userIds.has(lead) ? lead : null,
          priority: toTaskPriority(meta.priority),
          sortOrder: projects.length,
          statusType: paused ? 'paused' : base,
          statusName: statusLabel(meta.status),
          initiativeIds,
          teamIds: [PLANNING_TEAM_ID],
          startDate: calendarDate(meta.startDate),
          targetDate: calendarDate(meta.dueDate),
        });
        break;
      }
      case 'milestone':
        // The project is resolved below, once the synthetic lanes exist.
        milestones.push({
          id: meta.id,
          projectId: '',
          name: meta.title,
          description: descriptionOf(doc),
          targetDate: calendarDate(meta.dueDate),
          sortOrder: milestones.length,
        });
        break;
      default:
        issueDocs.push(doc);
    }
  }

  // Each milestone's project: the nearest above it, else the synthetic "No
  // project" lane of its initiative (or the root), made on first use.
  const syntheticProjects = new Map<string, Project>();
  const milestoneProject = new Map<string, string>();
  for (const milestone of milestones) {
    const up = above(milestone.id);
    let projectId = up.projectId;
    if (projectId === null) {
      projectId = noProjectId(up.initiativeId);
      if (!syntheticProjects.has(projectId)) {
        syntheticProjects.set(projectId, {
          id: projectId,
          name: 'No project',
          url: up.initiativeId === null ? '' : hrefFor(up.initiativeId),
          leadId: null,
          priority: 0,
          // After every real project of its group (none, then last).
          sortOrder: Number.MAX_SAFE_INTEGER,
          statusType: 'backlog',
          statusName: 'No project',
          initiativeIds: up.initiativeId === null ? [] : [up.initiativeId],
          teamIds: [PLANNING_TEAM_ID],
          startDate: null,
          targetDate: null,
        });
      }
    }
    milestone.projectId = projectId;
    milestoneProject.set(milestone.id, projectId);
  }
  projects.push(...syntheticProjects.values());

  const issueIds = new Set(issueDocs.map((doc) => doc.meta.id));
  const issues: Issue[] = [];
  const relations: BlockingRelation[] = [];
  for (const doc of issueDocs) {
    const { meta } = doc;
    const up = above(meta.id);
    // An issue under a milestone sits in the milestone's lane, synthetic or
    // not, so the two indexes agree.
    const projectId =
      up.milestoneId === null
        ? up.projectId
        : (milestoneProject.get(up.milestoneId) ?? up.projectId);
    const type = statusType(meta.status, model);
    const started = input.latestRunByTaskId?.get(meta.id)?.createdAt ?? null;
    issues.push({
      id: meta.id,
      identifier:
        resolveLinearLink(meta.external, links)?.identifier ?? meta.id,
      title: meta.title,
      url: hrefFor(meta.id),
      teamId: PLANNING_TEAM_ID,
      projectId,
      milestoneId: up.milestoneId,
      assigneeId: assigneeId(meta.assignee),
      stateId: canonicalStatus(meta.status),
      priority: toTaskPriority(meta.priority),
      createdAt: meta.created,
      updatedAt: meta.updated,
      startedAt: started ?? (type === 'started' ? meta.updated : null),
      completedAt: type === 'completed' ? meta.updated : null,
      canceledAt: type === 'canceled' ? meta.updated : null,
      lastStateChangeAt: meta.updated,
      dueDate: calendarDate(meta.dueDate),
    });
    for (const blockerId of meta.blockedBy) {
      if (!issueIds.has(blockerId)) continue;
      relations.push({
        id: `${blockerId}->${meta.id}`,
        blockerId,
        blockedId: meta.id,
      });
    }
  }

  return {
    workspaceId: WORKSPACE_ID,
    users,
    teams: [team],
    states,
    initiatives,
    projects,
    milestones,
    issues,
    relations,
  };
}

/**
 * The evaluation context for `now`: today as the local calendar day (what
 * `dueDate` is stored in), the instant, the tuning, and no tool-owned
 * milestone meta (Dispatch keeps no weights or "done means…" of its own; a
 * milestone's "done means" comes from its description).
 */
export function buildEvalContext(
  now: Date,
  tuning: Tuning = DEFAULT_TUNING
): EvalContext {
  return {
    today: dayFromNow(0, now),
    now: now.toISOString(),
    tuning,
    meta: new Map<string, MilestoneMeta>(),
  };
}
