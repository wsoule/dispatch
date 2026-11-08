import type {
  Person,
  Priority,
  StatusDefinition,
  StatusType,
  TaskDoc,
  TaskKind,
  TaskMeta,
} from '@dispatch-foo/core';
import { defaultTaskFields, linearExternal } from '@dispatch-foo/core';
import type { ProjectStatusType, WorkspaceData } from '@dispatch/planning';
import { createHash } from 'node:crypto';

// A Linear workspace as the Dispatch task list a daemon serves. The desktop's
// planning views read only that list (apps/desktop/src/adapters/
// workspaceData.ts turns it back into WorkspaceData), so the hosted planner
// answers the daemon's read routes from this model.

interface LinearIssueLink {
  identifier: string;
  url: string;
}

export interface DaemonModel {
  tasks: TaskDoc[];
  /** config.statusDefinitions: one per distinct workflow state name. */
  statusDefinitions: StatusDefinition[];
  people: Person[];
  /** /api/linear/links: Linear issue id → identifier and url. */
  links: Record<string, LinearIssueLink>;
}

const PRIORITY: Record<number, Priority> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

// A project's status as the workflow-state type the desktop reads back
// (its PROJECT_STATUS map, inverted). Paused has no type of its own.
const PROJECT_TYPE: Record<ProjectStatusType, StatusType> = {
  backlog: 'backlog',
  planned: 'unstarted',
  started: 'started',
  paused: 'started',
  completed: 'completed',
  canceled: 'canceled',
};

// Task ids must look like Dispatch's (`t-`/`e-` + hex) for links and routes;
// a hash of the Linear id keeps them stable across fetches.
function taskId(kind: TaskKind, linearId: string): string {
  const hex = createHash('sha256').update(linearId).digest('hex').slice(0, 10);
  return `${kind === 'task' ? 't' : 'e'}-${hex}`;
}

// A Linear display name as a Dispatch human handle (`[a-z0-9][a-z0-9._-]*`),
// suffixed when two people would collide.
function handleFor(name: string, taken: Set<string>): string {
  const derived = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 39);
  const base = derived === '' ? 'user' : derived;
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${String(n)}`;
  taken.add(handle);
  return handle;
}

/** Converts one fetched Linear workspace. `now` dates the containers, which
 * WorkspaceData carries no timestamps for. Pure. */
export function toDispatch(data: WorkspaceData, now: string): DaemonModel {
  // Statuses: the first state of each name decides its type.
  const statusDefinitions: StatusDefinition[] = [];
  const stateName = new Map<string, string>();
  for (const state of [...data.states].sort(
    (a, b) => a.position - b.position
  )) {
    stateName.set(state.id, state.name);
    if (!statusDefinitions.some((d) => d.name === state.name))
      statusDefinitions.push({
        name: state.name,
        type: state.type,
        color: null,
      });
  }
  const firstOfType = (type: StatusType): string => {
    const found = statusDefinitions.find((d) => d.type === type);
    if (found !== undefined) return found.name;
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    statusDefinitions.push({ name, type, color: null });
    return name;
  };

  const taken = new Set<string>();
  const refOf = new Map<string, string>();
  const people: Person[] = data.users.map((user) => {
    const ref = `human:${handleFor(user.displayName === '' ? user.name : user.displayName, taken)}`;
    refOf.set(user.id, ref);
    return {
      ref,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      external: `linear:${user.id}`,
    };
  });
  const assignee = (userId: string | null): string =>
    userId === null ? 'none' : (refOf.get(userId) ?? 'none');

  const base = (
    kind: TaskKind,
    linearId: string,
    fields: Partial<TaskMeta> & Pick<TaskMeta, 'title' | 'status'>
  ): TaskMeta => ({
    ...defaultTaskFields(),
    id: taskId(kind, linearId),
    kind,
    parent: null,
    milestone: null,
    blockedBy: [],
    labels: [],
    priority: 'none',
    assignee: 'none',
    created: now,
    updated: now,
    external: null,
    selfReview: false,
    writes: [],
    risk: 'routine',
    model: null,
    exercised: false,
    ...fields,
  });

  const tasks: TaskDoc[] = [];
  for (const initiative of data.initiatives)
    tasks.push({
      meta: base('initiative', initiative.id, {
        title: initiative.name,
        status: firstOfType('unstarted'),
        priority: PRIORITY[initiative.priority] ?? 'none',
        dueDate: initiative.targetDate ?? null,
        sortOrder: initiative.sortOrder,
        external: linearExternal({ entity: 'initiative', id: initiative.id }),
      }),
      body: '',
    });
  for (const project of data.projects) {
    const [home, ...also] = project.initiativeIds;
    tasks.push({
      meta: base('project', project.id, {
        title: project.name,
        status: firstOfType(PROJECT_TYPE[project.statusType]),
        priority: PRIORITY[project.priority] ?? 'none',
        assignee: assignee(project.leadId),
        parent: home === undefined ? null : taskId('initiative', home),
        initiatives: also.map((id) => taskId('initiative', id)),
        startDate: project.startDate ?? null,
        dueDate: project.targetDate ?? null,
        sortOrder: project.sortOrder,
        external: linearExternal({ entity: 'project', id: project.id }),
      }),
      body: '',
    });
  }
  for (const milestone of data.milestones)
    tasks.push({
      meta: base('milestone', milestone.id, {
        title: milestone.name,
        status: firstOfType('unstarted'),
        parent: taskId('project', milestone.projectId),
        dueDate: milestone.targetDate ?? null,
        sortOrder: milestone.sortOrder,
        external: linearExternal({ entity: 'milestone', id: milestone.id }),
      }),
      // The desktop reads a milestone's "Done means…" from this section.
      body:
        milestone.description === null || milestone.description === ''
          ? ''
          : `## Description\n\n${milestone.description}\n`,
    });

  const blockers = new Map<string, string[]>();
  for (const relation of data.relations) {
    const list = blockers.get(relation.blockedId) ?? [];
    list.push(taskId('task', relation.blockerId));
    blockers.set(relation.blockedId, list);
  }
  const links: Record<string, LinearIssueLink> = {};
  for (const issue of data.issues) {
    const milestone =
      issue.milestoneId === null
        ? null
        : taskId('milestone', issue.milestoneId);
    const project =
      issue.projectId === null ? null : taskId('project', issue.projectId);
    links[issue.id] = { identifier: issue.identifier, url: issue.url };
    tasks.push({
      meta: base('task', issue.id, {
        title: issue.title,
        status: stateName.get(issue.stateId) ?? firstOfType('backlog'),
        priority: PRIORITY[issue.priority] ?? 'none',
        assignee: assignee(issue.assigneeId),
        parent: milestone ?? project,
        milestone,
        blockedBy: blockers.get(issue.id) ?? [],
        created: issue.createdAt,
        updated: issue.updatedAt,
        dueDate: issue.dueDate ?? null,
        external: linearExternal({ entity: 'issue', id: issue.id }),
      }),
      body: '',
    });
  }
  return { tasks, statusDefinitions, people, links };
}
