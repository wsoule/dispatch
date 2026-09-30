// Shared builders for the Linear mapping tests: a small linked workspace, and
// a materializer that applies a push to an issue the way Linear would.
import type { IssuePush, LinearMapContext } from '../src/linearFields.js';
import { labelKey } from '../src/linearFields.js';
import type {
  LinearIssue,
  LinearLabel,
  LinearProjectStatus,
  LinearWorkflowState,
} from '../src/linearMap.js';
import { linearExternal } from '../src/linearMap.js';
import type { LinearEntity } from '../src/linearMap.js';
import { peopleIndex } from '../src/linearPeople.js';
import {
  defaultStatusRoles,
  statusesFromWorkflowStates,
} from '../src/linearStatuses.js';
import type { Person } from '../src/people.js';
import type { TaskDoc, TaskKind, TaskMeta } from '../src/types.js';
import { defaultTaskFields } from '../src/types.js';

export const STATES: LinearWorkflowState[] = [
  {
    id: 's-triage',
    name: 'Triage',
    type: 'triage',
    color: '#fc7840',
    position: 0,
  },
  {
    id: 's-backlog',
    name: 'Backlog',
    type: 'backlog',
    color: '#bbbbbb',
    position: 0,
  },
  {
    id: 's-todo',
    name: 'Todo',
    type: 'unstarted',
    color: '#e2e2e2',
    position: 0,
  },
  {
    id: 's-progress',
    name: 'In Progress',
    type: 'started',
    color: '#f2c94c',
    position: 0,
  },
  { id: 's-qa', name: 'QA', type: 'started', color: '#26b5ce', position: 1 },
  {
    id: 's-review',
    name: 'In Review',
    type: 'started',
    color: '#0f783c',
    position: 2,
  },
  {
    id: 's-done',
    name: 'Done',
    type: 'completed',
    color: '#5e6ad2',
    position: 0,
  },
  {
    id: 's-canceled',
    name: 'Canceled',
    type: 'canceled',
    color: '#95a2b3',
    position: 0,
  },
  {
    id: 's-dup',
    name: 'Duplicate',
    type: 'duplicate',
    color: '#95a2b3',
    position: 1,
  },
];

export const LABELS: LinearLabel[] = [
  { id: 'l-web', name: 'web', color: '#00f', group: null, teamId: 'team-1' },
  { id: 'l-bug', name: 'Bug', color: '#f00', group: 'Type', teamId: 'team-1' },
  { id: 'l-infra', name: 'infra', color: '#0f0', group: null, teamId: null },
];

const PEOPLE: Person[] = [
  { ref: 'human:wyat', name: 'Wyat Soule', external: 'linear:u-me' },
  { ref: 'human:ana', name: 'Ana Lima', external: 'linear:u-ana' },
];

export const PROJECT_STATUSES: LinearProjectStatus[] = [
  { id: 'ps-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'ps-planned', name: 'Planned', type: 'planned' },
  { id: 'ps-started', name: 'In Progress', type: 'started' },
  { id: 'ps-paused', name: 'Paused', type: 'paused' },
  { id: 'ps-completed', name: 'Completed', type: 'completed' },
  { id: 'ps-canceled', name: 'Canceled', type: 'canceled' },
];

function meta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 't-000000',
    title: 'Task',
    status: 'Todo',
    kind: 'task',
    parent: null,
    milestone: null,
    blockedBy: [],
    labels: [],
    priority: 'none',
    assignee: 'none',
    created: '2026-07-01T00:00:00.000Z',
    updated: '2026-07-01T00:00:00.000Z',
    external: null,
    selfReview: true,
    writes: [],
    risk: 'routine',
    model: null,
    exercised: false,
    ...defaultTaskFields(),
    ...overrides,
  };
}

export const TEMPLATE_BODY =
  '\n## Description\n\n## Acceptance Criteria\n\n## Activity\n';

export function doc(
  overrides: Partial<TaskMeta> = {},
  body = TEMPLATE_BODY
): TaskDoc {
  return { meta: meta(overrides), body };
}

/** A task linked to a Linear record of `entity`. */
export function linked(
  id: string,
  entity: LinearEntity,
  remoteId: string,
  kind: TaskKind = entity === 'issue' ? 'task' : entity,
  overrides: Partial<TaskMeta> = {}
): TaskMeta {
  return meta({
    id,
    kind,
    external: linearExternal({ entity, id: remoteId }),
    ...overrides,
  });
}

export function blankIssue(
  id: string,
  overrides: Partial<LinearIssue> = {}
): LinearIssue {
  return {
    id,
    identifier: `HYD-${id}`,
    title: 'Issue',
    description: null,
    priority: 0,
    estimate: null,
    url: `https://linear.app/acme/issue/${id}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    archivedAt: null,
    dueDate: null,
    state: STATES[2],
    labels: [],
    team: { id: 'team-1', key: 'HYD' },
    assigneeId: null,
    creatorId: null,
    cycle: null,
    projectId: null,
    projectMilestoneId: null,
    parentId: null,
    childIds: [],
    relations: [],
    attachments: [],
    truncated: [],
    ...overrides,
  };
}

/** Labels by lowercased key, each key listing every label that spells it. */
function labelIndex(
  labels: readonly LinearLabel[]
): Map<string, LinearLabel[]> {
  const out = new Map<string, LinearLabel[]>();
  for (const l of labels) {
    const key = labelKey(l).toLowerCase();
    out.set(key, [...(out.get(key) ?? []), l]);
  }
  return out;
}

/** A mapping context over `tasks`, with the fixture workspace's vocabulary. */
export function context(
  tasks: readonly TaskMeta[],
  opts: { includeAcceptanceCriteria?: boolean; labels?: LinearLabel[] } = {}
): LinearMapContext {
  const generated = statusesFromWorkflowStates(STATES);
  const labels = opts.labels ?? LABELS;
  const taskByRemote = new Map<string, string>();
  for (const t of tasks) {
    const ext = t.external ?? '';
    const colon = ext.indexOf(':');
    if (colon > 0) taskByRemote.set(ext.slice(colon + 1), t.id);
  }
  return {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    taskByRemote,
    statusByState: new Map(Object.entries(generated.names)),
    teamStates: new Map([['team-1', STATES]]),
    defaultTeamId: 'team-1',
    model: {
      definitions: generated.definitions,
      roles: defaultStatusRoles(generated.definitions),
    },
    people: peopleIndex(PEOPLE, 'human:wyat'),
    labels: labelIndex(labels),
    labelsById: new Map(labels.map((l) => [l.id, l])),
    includeAcceptanceCriteria: opts.includeAcceptanceCriteria ?? true,
    projectStatuses: PROJECT_STATUSES,
  };
}

/** Applies a push to an issue the way Linear would. */
export function materialize(
  base: LinearIssue,
  push: IssuePush,
  labels: readonly LinearLabel[] = LABELS
): LinearIssue {
  const next = structuredClone(base);
  const input = push.input;
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.estimate !== undefined) next.estimate = input.estimate;
  if (input.stateId !== undefined) {
    next.state = STATES.find((s) => s.id === input.stateId) ?? next.state;
  }
  if (input.assigneeId !== undefined) next.assigneeId = input.assigneeId;
  if (input.labelIds !== undefined) {
    next.labels = labels
      .filter((l) => input.labelIds?.includes(l.id) === true)
      .map((l) => ({ id: l.id, name: l.name }));
  }
  if (input.dueDate !== undefined) next.dueDate = input.dueDate;
  if (input.cycleId !== undefined) {
    next.cycle =
      input.cycleId === null
        ? null
        : {
            id: input.cycleId,
            number: 1,
            name: null,
            startsAt: 'a',
            endsAt: 'b',
          };
  }
  if (input.projectId !== undefined) next.projectId = input.projectId;
  if (input.projectMilestoneId !== undefined) {
    next.projectMilestoneId = input.projectMilestoneId;
  }
  if (input.parentId !== undefined) next.parentId = input.parentId;
  next.relations = next.relations.filter(
    (r) => !push.relations.remove.includes(r.id)
  );
  push.relations.create.forEach((r, n) =>
    next.relations.push({ id: `new-rel-${n}`, ...r })
  );
  next.attachments = next.attachments.filter(
    (a) => !push.links.remove.includes(a.id)
  );
  for (const link of push.links.add) {
    const had = next.attachments.find((a) => a.url === link.url);
    if (had !== undefined) had.title = link.title;
    else {
      next.attachments.push({
        id: `new-att-${link.url}`,
        title: link.title,
        url: link.url,
        subtitle: null,
        sourceType: null,
      });
    }
  }
  if (push.archive === true) next.archivedAt = '2026-07-09T00:00:00.000Z';
  if (push.archive === false) next.archivedAt = null;
  return next;
}

/** A small seeded PRNG (mulberry32), so a failing property run reproduces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}
